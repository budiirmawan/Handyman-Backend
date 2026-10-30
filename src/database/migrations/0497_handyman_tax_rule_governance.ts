import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Tax rule definitions and Finance decisions only. No money or fiscal facts are changed. */
export const migration0497HandymanTaxRuleGovernance: Migration = {
  id: '0497_handyman_tax_rule_governance',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`INSERT INTO permissions (id, code, name, status)
      VALUES ($1, 'handyman.tax_rule.approve', 'Approve or reject Handyman tax rules', 'ACTIVE')
      ON CONFLICT (code) DO NOTHING`, [randomUUID()]);
    await tx.query(`
      CREATE TABLE handyman_tax_rules (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        transaction_context TEXT NOT NULL CHECK (transaction_context IN ('CUSTOMER_SERVICE_BILLING', 'BM_COMMISSION')),
        tax_code TEXT NOT NULL CHECK (tax_code IN ('PPN', 'PPH_WITHHOLDING')),
        taxpayer_classification TEXT NOT NULL CHECK (taxpayer_classification ~ '^[A-Z][A-Z0-9_]{1,63}$'
          AND taxpayer_classification NOT IN ('UNKNOWN','ANY','ALL','DEFAULT','NONE','PKP','NON_PKP')),
        classification_description TEXT NOT NULL CHECK (char_length(btrim(classification_description)) BETWEEN 1 AND 500
          AND classification_description=btrim(classification_description) AND classification_description !~ '[[:cntrl:]]'),
        version INTEGER NOT NULL CHECK (version > 0),
        effective_from DATE NOT NULL CHECK (isfinite(effective_from) AND effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
        declared_effective_to DATE CHECK (isfinite(declared_effective_to)
          AND declared_effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND declared_effective_to > effective_from),
        basis_method_code TEXT NOT NULL CHECK (basis_method_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
          AND basis_method_code NOT IN ('UNKNOWN','ANY','ALL','DEFAULT','NONE','PKP','NON_PKP')),
        basis_description TEXT NOT NULL CHECK (char_length(btrim(basis_description)) BETWEEN 1 AND 500
          AND basis_description=btrim(basis_description) AND basis_description !~ '[[:cntrl:]]'),
        rate_percent NUMERIC NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100 AND scale(rate_percent) <= 6),
        rounding_mode TEXT NOT NULL CHECK (rounding_mode IN ('HALF_UP','HALF_EVEN','DOWN','UP','NO_ROUNDING')),
        rounding_scale SMALLINT,
        legal_reference TEXT NOT NULL CHECK (char_length(btrim(legal_reference)) BETWEEN 1 AND 500
          AND legal_reference=btrim(legal_reference) AND legal_reference !~ '[[:cntrl:]]'),
        legal_source TEXT NOT NULL CHECK (char_length(btrim(legal_source)) BETWEEN 1 AND 500
          AND legal_source=btrim(legal_source) AND legal_source !~ '[[:cntrl:]]'),
        evidence_source TEXT NOT NULL CHECK (char_length(btrim(evidence_source)) BETWEEN 1 AND 200
          AND evidence_source=btrim(evidence_source) AND evidence_source !~ '[[:cntrl:]]'),
        evidence_reference TEXT NOT NULL CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500
          AND evidence_reference=btrim(evidence_reference) AND evidence_reference !~ '[[:cntrl:]]'),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((rounding_mode='NO_ROUNDING' AND rounding_scale IS NULL)
          OR (rounding_mode<>'NO_ROUNDING' AND rounding_scale IS NOT NULL AND rounding_scale BETWEEN 0 AND 6)),
        UNIQUE (client_id, transaction_context, tax_code, taxpayer_classification, version)
      );
      CREATE TABLE handyman_tax_rule_windows (
        rule_id UUID PRIMARY KEY REFERENCES handyman_tax_rules(id),
        client_id UUID NOT NULL REFERENCES clients(id),
        transaction_context TEXT NOT NULL,
        tax_code TEXT NOT NULL,
        taxpayer_classification TEXT NOT NULL,
        effective_from DATE NOT NULL,
        effective_to DATE,
        CONSTRAINT hm_tax_rule_window_no_overlap EXCLUDE USING gist (
          client_id WITH =, transaction_context WITH =, tax_code WITH =, taxpayer_classification WITH =,
          daterange(effective_from, effective_to, '[)') WITH &&
        )
      );
      CREATE TABLE handyman_tax_rule_closures (
        id UUID PRIMARY KEY,
        rule_id UUID NOT NULL UNIQUE REFERENCES handyman_tax_rules(id),
        effective_to DATE NOT NULL CHECK (isfinite(effective_to)
          AND effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
        reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500
          AND reason=btrim(reason) AND reason !~ '[[:cntrl:]]'),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE handyman_tax_rule_approval_events (
        id UUID PRIMARY KEY,
        rule_id UUID NOT NULL REFERENCES handyman_tax_rules(id),
        client_id UUID NOT NULL REFERENCES clients(id),
        rule_version INTEGER NOT NULL CHECK (rule_version > 0),
        rule_digest TEXT NOT NULL CHECK (rule_digest ~ '^[0-9a-f]{64}$'),
        event_type TEXT NOT NULL CHECK (event_type IN ('SUBMIT','APPROVE','REJECT')),
        submission_id UUID REFERENCES handyman_tax_rule_approval_events(id),
        source_validation TEXT,
        actor_user_id UUID NOT NULL REFERENCES users(id),
        evidence_source TEXT NOT NULL CHECK (char_length(btrim(evidence_source)) BETWEEN 1 AND 200
          AND evidence_source=btrim(evidence_source) AND evidence_source !~ '[[:cntrl:]]'),
        evidence_reference TEXT NOT NULL CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 500
          AND evidence_reference=btrim(evidence_reference) AND evidence_reference !~ '[[:cntrl:]]'),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        review_from DATE NOT NULL,
        review_to DATE,
        CHECK ((event_type='SUBMIT' AND submission_id IS NULL)
          OR (event_type IN ('APPROVE','REJECT') AND submission_id IS NOT NULL)),
        CHECK ((event_type='APPROVE' AND source_validation IS NOT DISTINCT FROM 'FINANCE_VALIDATED')
          OR (event_type IN ('SUBMIT','REJECT') AND source_validation IS NULL))
      );
      CREATE UNIQUE INDEX hm_tax_rule_one_submission ON handyman_tax_rule_approval_events(rule_id) WHERE event_type='SUBMIT';
      CREATE UNIQUE INDEX hm_tax_rule_one_decision ON handyman_tax_rule_approval_events(submission_id) WHERE event_type IN ('APPROVE','REJECT');
      CREATE INDEX hm_tax_rule_scope_idx ON handyman_tax_rules(client_id,transaction_context,tax_code,taxpayer_classification,version);

      -- The V1 snapshot is scalar-only and uses the same sorted-key JSON and
      -- UTC-millisecond SHA-256 convention as 0495/0496. Percent is a string.
      CREATE FUNCTION hm_tax_rule_payload_digest(rule_uuid UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
        SELECT encode(digest(convert_to('{' || (
          SELECT string_agg(to_json(k)::text || ':' || v::text, ',' ORDER BY k COLLATE "C")
          FROM json_each(json_build_object(
            'schema','HANDYMAN_TAX_RULE_V1', 'id',r.id::text, 'clientId',r.client_id::text,
            'transactionContext',r.transaction_context, 'taxCode',r.tax_code,
            'taxpayerClassification',r.taxpayer_classification, 'classificationDescription',r.classification_description,
            'version',r.version, 'effectiveFrom',to_char(r.effective_from,'YYYY-MM-DD'),
            'declaredEffectiveTo',CASE WHEN r.declared_effective_to IS NULL THEN NULL ELSE to_char(r.declared_effective_to,'YYYY-MM-DD') END,
            'basisMethodCode',r.basis_method_code, 'basisDescription',r.basis_description,
            'ratePercent',r.rate_percent::text, 'roundingMode',r.rounding_mode, 'roundingScale',r.rounding_scale,
            'legalReference',r.legal_reference, 'legalSource',r.legal_source,
            'evidenceSource',r.evidence_source, 'evidenceReference',r.evidence_reference,
            'createdByUserId',r.created_by_user_id::text,
            'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )) AS j(k,v)
        ) || '}', 'UTF8'), 'sha256'), 'hex') FROM handyman_tax_rules r
        WHERE r.id=rule_uuid AND r.created_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00'
          AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
      $$;
      CREATE FUNCTION hm_tax_rule_actor_authorized(actor UUID, client UUID, permission_code TEXT) RETURNS BOOLEAN
      LANGUAGE sql STABLE AS $$
        SELECT hm_tax_identity_actor_has_permission(actor, permission_code)
          AND EXISTS (SELECT 1 FROM user_building_assignments uba
            JOIN buildings b ON b.id=uba.building_id AND b.status='ACTIVE'
            JOIN properties pr ON pr.id=b.property_id
            WHERE uba.user_id=actor AND uba.status='ACTIVE' AND pr.client_id=client)
      $$;
      CREATE FUNCTION hm_tax_rule_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Tax rules, closures and approval events are immutable history.' USING ERRCODE='23514';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_rule_no_mutation BEFORE UPDATE OR DELETE ON handyman_tax_rules
        FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_immutable();
      CREATE TRIGGER hm_tax_rule_closure_no_mutation BEFORE UPDATE OR DELETE ON handyman_tax_rule_closures
        FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_immutable();
      CREATE TRIGGER hm_tax_rule_event_no_mutation BEFORE UPDATE OR DELETE ON handyman_tax_rule_approval_events
        FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_immutable();

      CREATE FUNCTION hm_tax_rule_validate() RETURNS trigger AS $$
      DECLARE next_version INTEGER;
      BEGIN
        PERFORM 1 FROM clients WHERE id=NEW.client_id FOR UPDATE;
        IF NOT FOUND OR NOT hm_tax_rule_actor_authorized(NEW.created_by_user_id,NEW.client_id,'handyman.finance.manage') THEN
          RAISE EXCEPTION 'An active scoped Finance maker is required.' USING ERRCODE='23514';
        END IF;
        SELECT COALESCE(MAX(version),0)+1 INTO next_version FROM handyman_tax_rules
          WHERE client_id=NEW.client_id AND transaction_context=NEW.transaction_context
            AND tax_code=NEW.tax_code AND taxpayer_classification=NEW.taxpayer_classification;
        IF NEW.version<>next_version THEN
          RAISE EXCEPTION 'Tax rule version must follow its exact scope history.' USING ERRCODE='23514';
        END IF;
        NEW.created_at := date_trunc('milliseconds',clock_timestamp());
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_rule_validate BEFORE INSERT ON handyman_tax_rules
        FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_validate();

      CREATE FUNCTION hm_tax_rule_window_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'Tax rule window is a protected projection.' USING ERRCODE='23514';
        ELSIF TG_OP='INSERT' THEN
          IF NOT EXISTS (SELECT 1 FROM handyman_tax_rules r WHERE r.id=NEW.rule_id AND r.client_id=NEW.client_id
            AND r.transaction_context=NEW.transaction_context AND r.tax_code=NEW.tax_code
            AND r.taxpayer_classification=NEW.taxpayer_classification AND r.effective_from=NEW.effective_from
            AND r.declared_effective_to IS NOT DISTINCT FROM NEW.effective_to) THEN
            RAISE EXCEPTION 'Tax rule window must project its immutable rule.' USING ERRCODE='23514';
          END IF;
        ELSE
          IF ROW(NEW.rule_id,NEW.client_id,NEW.transaction_context,NEW.tax_code,NEW.taxpayer_classification,NEW.effective_from)
            IS DISTINCT FROM ROW(OLD.rule_id,OLD.client_id,OLD.transaction_context,OLD.tax_code,OLD.taxpayer_classification,OLD.effective_from)
            OR NOT EXISTS (SELECT 1 FROM handyman_tax_rule_closures c WHERE c.rule_id=NEW.rule_id AND c.effective_to=NEW.effective_to) THEN
            RAISE EXCEPTION 'Tax rule window changes require the exact immutable closure.' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_rule_window_guard BEFORE INSERT OR UPDATE OR DELETE ON handyman_tax_rule_windows
        FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_window_guard();
      CREATE FUNCTION hm_tax_rule_project() RETURNS trigger AS $$
      BEGIN
        INSERT INTO handyman_tax_rule_windows VALUES (NEW.id,NEW.client_id,NEW.transaction_context,NEW.tax_code,
          NEW.taxpayer_classification,NEW.effective_from,NEW.declared_effective_to);
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_rule_project AFTER INSERT ON handyman_tax_rules FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_project();

      CREATE FUNCTION hm_tax_rule_validate_closure() RETURNS trigger AS $$
      DECLARE r handyman_tax_rules%ROWTYPE; w handyman_tax_rule_windows%ROWTYPE;
        today DATE := (clock_timestamp() AT TIME ZONE 'Asia/Jakarta')::date;
      BEGIN
        SELECT * INTO r FROM handyman_tax_rules WHERE id=NEW.rule_id;
        IF r.id IS NULL THEN RAISE EXCEPTION 'Tax rule not found.' USING ERRCODE='23514'; END IF;
        PERFORM 1 FROM clients WHERE id=r.client_id FOR UPDATE;
        IF NOT hm_tax_rule_actor_authorized(NEW.created_by_user_id,r.client_id,'handyman.finance.manage') THEN
          RAISE EXCEPTION 'An active scoped Finance maker is required.' USING ERRCODE='23514';
        END IF;
        SELECT * INTO w FROM handyman_tax_rule_windows WHERE rule_id=r.id FOR UPDATE;
        IF w.rule_id IS NULL OR NEW.effective_to < w.effective_from
          OR NOT ((NEW.effective_to=w.effective_from AND w.effective_from>today)
            OR (NEW.effective_to>today AND NEW.effective_to>w.effective_from
              AND (w.effective_to IS NULL OR NEW.effective_to<w.effective_to))) THEN
          RAISE EXCEPTION 'Tax rule closure must be prospective, or cancel a future rule.' USING ERRCODE='23514';
        END IF;
        NEW.created_at := date_trunc('milliseconds',clock_timestamp());
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_rule_closure_validate BEFORE INSERT ON handyman_tax_rule_closures
        FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_validate_closure();
      CREATE FUNCTION hm_tax_rule_project_closure() RETURNS trigger AS $$
      BEGIN
        UPDATE handyman_tax_rule_windows SET effective_to=NEW.effective_to WHERE rule_id=NEW.rule_id;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_rule_closure_project AFTER INSERT ON handyman_tax_rule_closures
        FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_project_closure();

      CREATE FUNCTION hm_tax_rule_validate_event() RETURNS trigger AS $$
      DECLARE r handyman_tax_rules%ROWTYPE; w handyman_tax_rule_windows%ROWTYPE;
        s handyman_tax_rule_approval_events%ROWTYPE; closure_to DATE;
      BEGIN
        SELECT * INTO r FROM handyman_tax_rules WHERE id=NEW.rule_id;
        IF r.id IS NULL OR NEW.client_id IS DISTINCT FROM r.client_id OR NEW.rule_version IS DISTINCT FROM r.version THEN
          RAISE EXCEPTION 'Decision must pin its exact Client, rule and version.' USING ERRCODE='23514';
        END IF;
        PERFORM 1 FROM clients WHERE id=r.client_id FOR UPDATE;
        SELECT * INTO w FROM handyman_tax_rule_windows WHERE rule_id=r.id FOR UPDATE;
        IF w.rule_id IS NULL OR w.client_id IS DISTINCT FROM r.client_id
          OR w.transaction_context IS DISTINCT FROM r.transaction_context OR w.tax_code IS DISTINCT FROM r.tax_code
          OR w.taxpayer_classification IS DISTINCT FROM r.taxpayer_classification OR w.effective_from IS DISTINCT FROM r.effective_from THEN
          RAISE EXCEPTION 'Tax rule window projection does not match its exact rule.' USING ERRCODE='23514';
        END IF;
        SELECT effective_to INTO closure_to FROM handyman_tax_rule_closures WHERE rule_id=r.id;
        IF (FOUND AND w.effective_to IS DISTINCT FROM closure_to)
          OR (NOT FOUND AND w.effective_to IS DISTINCT FROM r.declared_effective_to) THEN
          RAISE EXCEPTION 'Tax rule window projection does not match its immutable closure.' USING ERRCODE='23514';
        END IF;
        IF NEW.rule_digest IS DISTINCT FROM hm_tax_rule_payload_digest(r.id) THEN
          RAISE EXCEPTION 'Tax rule digest does not match its immutable content.' USING ERRCODE='23514';
        END IF;
        IF NEW.event_type='SUBMIT' THEN
          IF NOT hm_tax_rule_actor_authorized(NEW.actor_user_id,r.client_id,'handyman.finance.manage') THEN
            RAISE EXCEPTION 'An active scoped Finance maker is required.' USING ERRCODE='23514';
          END IF;
          IF NEW.submission_id IS NOT NULL THEN RAISE EXCEPTION 'A submission cannot reference another event.' USING ERRCODE='23514'; END IF;
        ELSE
          IF NOT hm_tax_rule_actor_authorized(NEW.actor_user_id,r.client_id,'handyman.finance.read')
            OR NOT hm_tax_rule_actor_authorized(NEW.actor_user_id,r.client_id,'handyman.tax_rule.approve') THEN
            RAISE EXCEPTION 'An active scoped dedicated Finance checker is required.' USING ERRCODE='23514';
          END IF;
          SELECT * INTO s FROM handyman_tax_rule_approval_events WHERE id=NEW.submission_id;
          IF s.id IS NULL OR s.event_type<>'SUBMIT' OR s.rule_id IS DISTINCT FROM r.id
            OR s.client_id IS DISTINCT FROM r.client_id OR s.rule_version IS DISTINCT FROM r.version
            OR s.rule_digest IS DISTINCT FROM NEW.rule_digest THEN
            RAISE EXCEPTION 'Decision must pin the exact submitted rule and digest.' USING ERRCODE='23514';
          END IF;
          IF NEW.actor_user_id=s.actor_user_id OR NEW.actor_user_id=r.created_by_user_id THEN
            RAISE EXCEPTION 'Tax rule maker or author cannot check their own rule.' USING ERRCODE='23514';
          END IF;
        END IF;
        NEW.occurred_at := date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond';
        IF NEW.event_type<>'SUBMIT' AND NEW.occurred_at<=s.occurred_at THEN
          NEW.occurred_at := s.occurred_at + interval '1 millisecond';
        END IF;
        IF NEW.event_type IN ('SUBMIT','APPROVE') AND w.effective_to IS NOT NULL AND w.effective_to<=w.effective_from THEN
          RAISE EXCEPTION 'A cancelled tax rule cannot be submitted or approved.' USING ERRCODE='23514';
        END IF;
        IF NEW.event_type='SUBMIT' THEN
          NEW.review_from := w.effective_from; NEW.review_to := w.effective_to;
        ELSE
          NEW.review_from := s.review_from; NEW.review_to := s.review_to;
          IF NEW.event_type='APPROVE' AND (w.effective_from IS DISTINCT FROM s.review_from OR w.effective_to IS DISTINCT FROM s.review_to) THEN
            RAISE EXCEPTION 'The submitted tax rule window changed before approval.' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_tax_rule_event_validate BEFORE INSERT ON handyman_tax_rule_approval_events
        FOR EACH ROW EXECUTE FUNCTION hm_tax_rule_validate_event();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_tax_rules) OR EXISTS (SELECT 1 FROM handyman_tax_rule_closures)
          OR EXISTS (SELECT 1 FROM handyman_tax_rule_approval_events) THEN
          RAISE EXCEPTION 'Refusing to remove populated tax rule history.';
        END IF;
      END $$;
      DROP TABLE handyman_tax_rule_approval_events;
      DROP TABLE handyman_tax_rule_closures;
      DROP TABLE handyman_tax_rule_windows;
      DROP TABLE handyman_tax_rules;
      DROP FUNCTION hm_tax_rule_validate_event();
      DROP FUNCTION hm_tax_rule_project_closure();
      DROP FUNCTION hm_tax_rule_validate_closure();
      DROP FUNCTION hm_tax_rule_project();
      DROP FUNCTION hm_tax_rule_window_guard();
      DROP FUNCTION hm_tax_rule_validate();
      DROP FUNCTION hm_tax_rule_immutable();
      DROP FUNCTION hm_tax_rule_actor_authorized(UUID,UUID,TEXT);
      DROP FUNCTION hm_tax_rule_payload_digest(UUID);
    `);
    // Never silently revoke a deliberately granted capability.
  },
};
