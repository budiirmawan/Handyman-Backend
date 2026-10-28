import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** The immutable event is the Main Request closure authority. The existing
 * intake status and the independent execution/warranty lifecycles are retained. */
export const migration0534HandymanRequestClose: Migration = {
  id: '0534_handyman_request_close',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      CREATE TABLE handyman_request_close_events (
        id uuid PRIMARY KEY,
        request_id uuid NOT NULL UNIQUE,
        client_id uuid NOT NULL REFERENCES clients(id),
        building_id uuid NOT NULL REFERENCES buildings(id),
        tenant_company_id uuid NOT NULL REFERENCES tenant_companies(id),
        actor_user_id uuid NOT NULL REFERENCES users(id),
        actor_session_id uuid NOT NULL REFERENCES user_sessions(id),
        occurred_at timestamptz NOT NULL,
        reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
        idempotency_key text NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 128),
        scope_set_revision bigint NOT NULL CHECK(scope_set_revision >= 0),
        scope_set_fingerprint text NOT NULL CHECK(scope_set_fingerprint ~ '^[0-9a-f]{64}$'),
        source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
        source_canonical text NOT NULL,
        source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
        FOREIGN KEY (request_id,client_id) REFERENCES handyman_service_requests(id,client_id),
        CHECK(source_snapshot=source_canonical::jsonb
          AND source_sha256=encode(sha256(convert_to(source_canonical,'UTF8')),'hex')),
        CHECK(source_snapshot->>'protocol' IS NOT DISTINCT FROM 'HANDYMAN_REQUEST_CLOSE_V1'
          AND source_snapshot->>'status' IS NOT DISTINCT FROM 'CLOSED'
          AND source_snapshot->>'requestId' IS NOT DISTINCT FROM request_id::text
          AND source_snapshot->>'clientId' IS NOT DISTINCT FROM client_id::text
          AND source_snapshot->>'buildingId' IS NOT DISTINCT FROM building_id::text
          AND source_snapshot->>'tenantCompanyId' IS NOT DISTINCT FROM tenant_company_id::text
          AND source_snapshot->>'actorUserId' IS NOT DISTINCT FROM actor_user_id::text
          AND source_snapshot->>'actorSessionId' IS NOT DISTINCT FROM actor_session_id::text
          AND (source_snapshot->>'occurredAt')::timestamptz IS NOT DISTINCT FROM occurred_at
          AND source_snapshot->>'reason' IS NOT DISTINCT FROM reason
          AND source_snapshot->>'scopeSetRevision' IS NOT DISTINCT FROM scope_set_revision::text
          AND source_snapshot->>'scopeSetFingerprint' IS NOT DISTINCT FROM scope_set_fingerprint
          AND source_snapshot->'readiness'->>'status' IS NOT DISTINCT FROM 'READY'
          AND source_snapshot->'readiness'->>'requestId' IS NOT DISTINCT FROM request_id::text
          AND source_snapshot->'readiness'->>'scopeSetRevision' IS NOT DISTINCT FROM scope_set_revision::text
          AND source_snapshot->'readiness'->>'scopeSetFingerprint' IS NOT DISTINCT FROM scope_set_fingerprint
          AND source_snapshot->'readiness'->'operationalReadiness'->>'status' IS NOT DISTINCT FROM 'READY'
          AND source_snapshot->'readiness'->'blockers' IS NOT DISTINCT FROM '[]'::jsonb
          AND jsonb_typeof(source_snapshot->'sources') IS NOT DISTINCT FROM 'array'
          AND jsonb_array_length(source_snapshot->'sources')>0)
      );
      CREATE FUNCTION hm_request_close_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM handyman_request_close_events) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Main Request close events are immutable.' USING ERRCODE='23514';
      END; $$;
      CREATE TRIGGER hm_request_close_no_change BEFORE UPDATE OR DELETE ON handyman_request_close_events
        FOR EACH ROW EXECUTE FUNCTION hm_request_close_immutable();
      CREATE TRIGGER hm_request_close_no_truncate BEFORE TRUNCATE ON handyman_request_close_events
        FOR EACH STATEMENT EXECUTE FUNCTION hm_request_close_immutable();

      -- The service has already locked scopes, then the Request, then this
      -- fence and evaluated every readiness gate. The structural DB guard also
      -- rejects cross-context, inactive-session and stale-revision inserts.
      CREATE FUNCTION hm_request_close_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE current_revision bigint;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'Request CLOSE requires READ COMMITTED.' USING ERRCODE='23514', CONSTRAINT='hm_request_close_isolation';
        END IF;
        PERFORM 1 FROM handyman_service_requests WHERE id=NEW.request_id FOR NO KEY UPDATE;
        SELECT revision INTO current_revision FROM handyman_request_scope_set_revisions
          WHERE request_id=NEW.request_id FOR UPDATE;
        IF current_revision IS DISTINCT FROM NEW.scope_set_revision OR NOT EXISTS (
          SELECT 1 FROM handyman_service_requests r
          JOIN users u ON u.id=NEW.actor_user_id AND u.status='ACTIVE'
          JOIN user_sessions s ON s.id=NEW.actor_session_id AND s.user_id=u.id
            AND s.status='ACTIVE' AND s.expires_at>clock_timestamp()
          JOIN user_building_assignments a ON a.user_id=u.id AND a.building_id=r.building_id AND a.status='ACTIVE'
          JOIN buildings b ON b.id=r.building_id AND b.status='ACTIVE'
          JOIN properties p ON p.id=b.property_id AND p.client_id=r.client_id
          WHERE r.id=NEW.request_id AND r.client_id=NEW.client_id AND r.building_id=NEW.building_id
            AND r.tenant_company_id=NEW.tenant_company_id
            AND EXISTS (SELECT 1 FROM user_role_assignments ura JOIN roles ro ON ro.id=ura.role_id AND ro.status='ACTIVE'
              JOIN role_permission_assignments rpa ON rpa.role_id=ro.id AND rpa.status='ACTIVE'
              JOIN permissions pe ON pe.id=rpa.permission_id AND pe.status='ACTIVE' AND pe.code='finding.close'
              WHERE ura.user_id=u.id AND ura.status='ACTIVE')
        ) THEN
          RAISE EXCEPTION 'Current scoped Request close authority and revision are required.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_request_close_insert BEFORE INSERT ON handyman_request_close_events
        FOR EACH ROW EXECUTE FUNCTION hm_request_close_insert_guard();

      -- Same exclusive fence as CLOSE. An approval that wins first is visible
      -- to readiness; one that loses sees the committed close and fails. Sort
      -- inconsistent cross-linked Request IDs just as the 0533 bump does.
      CREATE FUNCTION hm_request_require_original_open(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE rid uuid;
      BEGIN
        -- An older REPEATABLE READ snapshot could miss the committed event after
        -- waiting for the fence, because CLOSE does not rewrite the revision.
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'Original approval requires READ COMMITTED.' USING ERRCODE='23514', CONSTRAINT='hm_request_close_isolation';
        END IF;
        FOR rid IN SELECT DISTINCT x FROM unnest(ids) x WHERE x IS NOT NULL ORDER BY x LOOP
          PERFORM 1 FROM handyman_request_scope_set_revisions WHERE request_id=rid FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Missing Request scope-set fence.' USING ERRCODE='23514';
          END IF;
          IF EXISTS (SELECT 1 FROM handyman_request_close_events WHERE request_id=rid) THEN
            RAISE EXCEPTION 'Main Request is CLOSED; new original commercial approval is not allowed.'
              USING ERRCODE='23514', CONSTRAINT='hm_request_closed_guard';
          END IF;
        END LOOP;
      END; $$;
      CREATE FUNCTION hm_request_guard_decision() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE from_quote uuid; from_version uuid;
      BEGIN
        IF NEW.decision<>'APPROVE' THEN RETURN NEW; END IF;
        SELECT handyman_request_id INTO from_quote FROM handyman_quotations WHERE id=NEW.quotation_id;
        SELECT q.handyman_request_id INTO from_version FROM handyman_quotation_versions v
          JOIN handyman_quotations q ON q.id=v.quotation_id WHERE v.id=NEW.quotation_version_id;
        PERFORM hm_request_require_original_open(ARRAY[from_quote,from_version]); RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_request_guard_decision BEFORE INSERT ON handyman_quotation_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_request_guard_decision();
      CREATE FUNCTION hm_request_guard_version() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE rid uuid;
      BEGIN
        IF NEW.status='APPROVED' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
          SELECT handyman_request_id INTO rid FROM handyman_quotations WHERE id=NEW.quotation_id;
          PERFORM hm_request_require_original_open(ARRAY[rid]);
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_request_guard_version BEFORE INSERT OR UPDATE OF status ON handyman_quotation_versions
        FOR EACH ROW EXECUTE FUNCTION hm_request_guard_version();
      CREATE FUNCTION hm_request_guard_original_scope() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE from_quote uuid; from_version uuid; from_decision uuid; from_decision_version uuid;
      BEGIN
        IF NEW.scope_kind<>'ORIGINAL' THEN RETURN NEW; END IF;
        SELECT handyman_request_id INTO from_quote FROM handyman_quotations WHERE id=NEW.quotation_id;
        SELECT q.handyman_request_id INTO from_version FROM handyman_quotation_versions v
          JOIN handyman_quotations q ON q.id=v.quotation_id WHERE v.id=NEW.approved_quotation_version_id;
        SELECT q.handyman_request_id INTO from_decision FROM handyman_quotation_decisions d
          JOIN handyman_quotations q ON q.id=d.quotation_id WHERE d.id=NEW.quotation_decision_id;
        SELECT q.handyman_request_id INTO from_decision_version FROM handyman_quotation_decisions d
          JOIN handyman_quotation_versions v ON v.id=d.quotation_version_id
          JOIN handyman_quotations q ON q.id=v.quotation_id WHERE d.id=NEW.quotation_decision_id;
        PERFORM hm_request_require_original_open(ARRAY[NEW.handyman_request_id,from_quote,from_version,from_decision,from_decision_version]);
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_request_guard_original_scope BEFORE INSERT ON handyman_execution_scopes
        FOR EACH ROW EXECUTE FUNCTION hm_request_guard_original_scope();
      CREATE FUNCTION hm_request_guard_variation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE rid uuid; kind text; approval_changed boolean;
      BEGIN
        SELECT handyman_request_id,scope_kind INTO rid,kind FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id;
        IF kind IS DISTINCT FROM 'ORIGINAL' THEN RETURN NEW; END IF;
        IF TG_OP='INSERT' THEN
          approval_changed := NEW.tenant_decision_outcome='APPROVED' OR NEW.status='AUTHORIZED_SCOPE';
        ELSE
          approval_changed := (NEW.status='AUTHORIZED_SCOPE' AND OLD.status IS DISTINCT FROM NEW.status)
            OR (NEW.tenant_decision_outcome='APPROVED' AND
              ROW(OLD.tenant_decision_outcome,OLD.tenant_decided_by_user_id,OLD.tenant_decided_at,OLD.revised_quotation_version_id,
                  OLD.variation_type,OLD.line_type,OLD.target_quotation_line_id,OLD.title,OLD.description,OLD.technical_finding,
                  OLD.quantity,OLD.uom_id,OLD.quoted_unit_amount,OLD.quoted_total_delta,OLD.currency)
              IS DISTINCT FROM
              ROW(NEW.tenant_decision_outcome,NEW.tenant_decided_by_user_id,NEW.tenant_decided_at,NEW.revised_quotation_version_id,
                  NEW.variation_type,NEW.line_type,NEW.target_quotation_line_id,NEW.title,NEW.description,NEW.technical_finding,
                  NEW.quantity,NEW.uom_id,NEW.quoted_unit_amount,NEW.quoted_total_delta,NEW.currency));
        END IF;
        IF approval_changed THEN PERFORM hm_request_require_original_open(ARRAY[NEW.handyman_request_id,rid]); END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_request_guard_variation BEFORE INSERT OR UPDATE ON handyman_scope_variations
        FOR EACH ROW EXECUTE FUNCTION hm_request_guard_variation();
      CREATE FUNCTION hm_request_guard_variation_event() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE event_request uuid; event_kind text; variation_request uuid; variation_scope_request uuid; variation_kind text;
      BEGIN
        IF NEW.event_type<>'AUTHORIZED_SCOPE' AND NOT (NEW.event_type='TENANT_DECISION' AND NEW.metadata->>'decisionOutcome'='APPROVED') THEN RETURN NEW; END IF;
        SELECT handyman_request_id,scope_kind INTO event_request,event_kind FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id;
        SELECT v.handyman_request_id,s.handyman_request_id,s.scope_kind INTO variation_request,variation_scope_request,variation_kind
          FROM handyman_scope_variations v JOIN handyman_execution_scopes s ON s.id=v.execution_scope_id WHERE v.id=NEW.variation_id;
        IF event_kind='ORIGINAL' OR variation_kind='ORIGINAL' THEN
          PERFORM hm_request_require_original_open(ARRAY[event_request,variation_request,variation_scope_request]);
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_request_guard_variation_event BEFORE INSERT ON handyman_scope_variation_events
        FOR EACH ROW EXECUTE FUNCTION hm_request_guard_variation_event();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_request_close_events) THEN
          RAISE EXCEPTION 'Cannot remove authoritative Request close history.' USING ERRCODE='23514';
        END IF;
      END; $$;
      DROP TRIGGER hm_request_guard_variation_event ON handyman_scope_variation_events;
      DROP FUNCTION hm_request_guard_variation_event();
      DROP TRIGGER hm_request_guard_variation ON handyman_scope_variations;
      DROP FUNCTION hm_request_guard_variation();
      DROP TRIGGER hm_request_guard_original_scope ON handyman_execution_scopes;
      DROP FUNCTION hm_request_guard_original_scope();
      DROP TRIGGER hm_request_guard_version ON handyman_quotation_versions;
      DROP FUNCTION hm_request_guard_version();
      DROP TRIGGER hm_request_guard_decision ON handyman_quotation_decisions;
      DROP FUNCTION hm_request_guard_decision();
      DROP FUNCTION hm_request_require_original_open(uuid[]);
      DROP TRIGGER hm_request_close_insert ON handyman_request_close_events;
      DROP FUNCTION hm_request_close_insert_guard();
      DROP TRIGGER hm_request_close_no_change ON handyman_request_close_events;
      DROP TRIGGER hm_request_close_no_truncate ON handyman_request_close_events;
      DROP FUNCTION hm_request_close_immutable();
      DROP TABLE handyman_request_close_events;
    `);
  },
};
