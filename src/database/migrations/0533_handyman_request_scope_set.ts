import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Request-local fence only. It records no membership, approval, cancellation,
 * supersession or close; old scope/decision facts are never backfilled. */
export const migration0533HandymanRequestScopeSet: Migration = {
  id: '0533_handyman_request_scope_set',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      -- No Request may be inserted between the backfill and trigger install.
      LOCK TABLE handyman_service_requests IN SHARE ROW EXCLUSIVE MODE;
      CREATE TABLE handyman_request_scope_set_revisions (
        request_id UUID PRIMARY KEY REFERENCES handyman_service_requests(id),
        revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
      );
      INSERT INTO handyman_request_scope_set_revisions(request_id)
        SELECT id FROM handyman_service_requests;
      CREATE FUNCTION hm_scope_set_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Scope-set revision fences cannot be deleted or truncated.' USING ERRCODE='23514'; END IF;
        IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.revision <> OLD.revision+1 THEN
          RAISE EXCEPTION 'Scope-set revisions are monotonic.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_scope_set_revision_guard BEFORE UPDATE OR DELETE ON handyman_request_scope_set_revisions
        FOR EACH ROW EXECUTE FUNCTION hm_scope_set_revision_guard();
      CREATE TRIGGER hm_scope_set_revision_no_truncate BEFORE TRUNCATE ON handyman_request_scope_set_revisions
        FOR EACH STATEMENT EXECUTE FUNCTION hm_scope_set_revision_guard();
      CREATE FUNCTION hm_scope_set_request_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO handyman_request_scope_set_revisions(request_id) VALUES (NEW.id);
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_scope_set_request_insert AFTER INSERT ON handyman_service_requests
        FOR EACH ROW EXECUTE FUNCTION hm_scope_set_request_insert();
      CREATE FUNCTION hm_scope_set_request_status() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          UPDATE handyman_request_scope_set_revisions SET revision=revision+1 WHERE request_id=NEW.id;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_scope_set_request_status AFTER UPDATE OF status ON handyman_service_requests
        FOR EACH ROW EXECUTE FUNCTION hm_scope_set_request_status();

      -- A common fence for snapshot consumers and every approval/membership
      -- writer. On inconsistent historical associations touch *both* request
      -- heads, never silently bless the association. Stable order avoids lock
      -- inversion when the two heads differ.
      CREATE FUNCTION hm_scope_set_bump(ids UUID[]) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE rid UUID;
      BEGIN
        FOR rid IN SELECT DISTINCT x FROM unnest(ids) x WHERE x IS NOT NULL ORDER BY x LOOP
          UPDATE handyman_request_scope_set_revisions SET revision=revision+1 WHERE request_id=rid;
          IF NOT FOUND THEN RAISE EXCEPTION 'Missing Handyman scope-set revision fence.' USING ERRCODE='23514'; END IF;
        END LOOP;
      END; $$;
      CREATE FUNCTION hm_scope_set_quotation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM hm_scope_set_bump(ARRAY[NEW.handyman_request_id]); RETURN NEW; END; $$;
      CREATE TRIGGER hm_scope_set_quotation AFTER INSERT ON handyman_quotations
        FOR EACH ROW EXECUTE FUNCTION hm_scope_set_quotation();
      CREATE FUNCTION hm_scope_set_version() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE rid UUID;
      BEGIN
        IF TG_OP='UPDATE' AND ROW(NEW.status,NEW.valid_until) IS NOT DISTINCT FROM ROW(OLD.status,OLD.valid_until) THEN
          RETURN NEW;
        END IF;
        SELECT handyman_request_id INTO rid FROM handyman_quotations WHERE id=NEW.quotation_id;
        PERFORM hm_scope_set_bump(ARRAY[rid]); RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_scope_set_version AFTER INSERT OR UPDATE OF status,valid_until ON handyman_quotation_versions
        FOR EACH ROW EXECUTE FUNCTION hm_scope_set_version();
      CREATE FUNCTION hm_scope_set_decision() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE from_quote UUID; from_version UUID;
      BEGIN
        SELECT handyman_request_id INTO from_quote FROM handyman_quotations WHERE id=NEW.quotation_id;
        SELECT q.handyman_request_id INTO from_version FROM handyman_quotation_versions v
          JOIN handyman_quotations q ON q.id=v.quotation_id WHERE v.id=NEW.quotation_version_id;
        PERFORM hm_scope_set_bump(ARRAY[from_quote,from_version]); RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_scope_set_decision AFTER INSERT ON handyman_quotation_decisions
        FOR EACH ROW EXECUTE FUNCTION hm_scope_set_decision();
      CREATE FUNCTION hm_scope_set_scope() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE from_quote UUID; from_version UUID; from_decision UUID; from_decision_version UUID;
      BEGIN
        IF NEW.scope_kind <> 'ORIGINAL' THEN RETURN NEW; END IF;
        SELECT handyman_request_id INTO from_quote FROM handyman_quotations WHERE id=NEW.quotation_id;
        SELECT q.handyman_request_id INTO from_version FROM handyman_quotation_versions v
          JOIN handyman_quotations q ON q.id=v.quotation_id WHERE v.id=NEW.approved_quotation_version_id;
        SELECT q.handyman_request_id INTO from_decision FROM handyman_quotation_decisions d
          JOIN handyman_quotations q ON q.id=d.quotation_id WHERE d.id=NEW.quotation_decision_id;
        SELECT q.handyman_request_id INTO from_decision_version FROM handyman_quotation_decisions d
          JOIN handyman_quotation_versions v ON v.id=d.quotation_version_id
          JOIN handyman_quotations q ON q.id=v.quotation_id WHERE d.id=NEW.quotation_decision_id;
        PERFORM hm_scope_set_bump(ARRAY[NEW.handyman_request_id,from_quote,from_version,from_decision,from_decision_version]); RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_scope_set_scope AFTER INSERT ON handyman_execution_scopes
        FOR EACH ROW EXECUTE FUNCTION hm_scope_set_scope();
      CREATE FUNCTION hm_scope_set_variation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE rid UUID; kind TEXT;
      BEGIN
        IF TG_OP='UPDATE' AND ROW(NEW.status,NEW.tenant_decision_outcome,NEW.revised_quotation_version_id,NEW.version)
          IS NOT DISTINCT FROM ROW(OLD.status,OLD.tenant_decision_outcome,OLD.revised_quotation_version_id,OLD.version) THEN
          RETURN NEW;
        END IF;
        SELECT handyman_request_id,scope_kind INTO rid,kind FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id;
        IF kind='ORIGINAL' THEN PERFORM hm_scope_set_bump(ARRAY[NEW.handyman_request_id,rid]); END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_scope_set_variation AFTER INSERT OR UPDATE OF status,tenant_decision_outcome,revised_quotation_version_id,version
        ON handyman_scope_variations FOR EACH ROW EXECUTE FUNCTION hm_scope_set_variation();
      CREATE FUNCTION hm_scope_set_variation_event() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE rid UUID; kind TEXT;
      BEGIN
        IF NEW.event_type NOT IN ('REVISED_QUOTATION','TENANT_DECISION','AUTHORIZED_SCOPE') THEN RETURN NEW; END IF;
        SELECT handyman_request_id,scope_kind INTO rid,kind FROM handyman_execution_scopes WHERE id=NEW.execution_scope_id;
        IF kind='ORIGINAL' THEN PERFORM hm_scope_set_bump(ARRAY[rid]); END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER hm_scope_set_variation_event AFTER INSERT ON handyman_scope_variation_events
        FOR EACH ROW EXECUTE FUNCTION hm_scope_set_variation_event();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      -- Published revision pins cannot safely be reset while Requests exist.
      LOCK TABLE handyman_service_requests IN SHARE ROW EXCLUSIVE MODE;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_service_requests) THEN
          RAISE EXCEPTION 'Cannot discard Request scope-set revision fences while Requests exist.' USING ERRCODE='23514';
        END IF;
      END; $$;
      DROP TRIGGER hm_scope_set_variation_event ON handyman_scope_variation_events;
      DROP FUNCTION hm_scope_set_variation_event();
      DROP TRIGGER hm_scope_set_variation ON handyman_scope_variations;
      DROP FUNCTION hm_scope_set_variation();
      DROP TRIGGER hm_scope_set_scope ON handyman_execution_scopes;
      DROP FUNCTION hm_scope_set_scope();
      DROP TRIGGER hm_scope_set_decision ON handyman_quotation_decisions;
      DROP FUNCTION hm_scope_set_decision();
      DROP TRIGGER hm_scope_set_version ON handyman_quotation_versions;
      DROP FUNCTION hm_scope_set_version();
      DROP TRIGGER hm_scope_set_quotation ON handyman_quotations;
      DROP FUNCTION hm_scope_set_quotation();
      DROP FUNCTION hm_scope_set_bump(UUID[]);
      DROP TRIGGER hm_scope_set_request_status ON handyman_service_requests;
      DROP FUNCTION hm_scope_set_request_status();
      DROP TRIGGER hm_scope_set_request_insert ON handyman_service_requests;
      DROP FUNCTION hm_scope_set_request_insert();
      DROP TRIGGER hm_scope_set_revision_no_truncate ON handyman_request_scope_set_revisions;
      DROP TRIGGER hm_scope_set_revision_guard ON handyman_request_scope_set_revisions;
      DROP FUNCTION hm_scope_set_revision_guard();
      DROP TABLE handyman_request_scope_set_revisions;
    `);
  },
};
