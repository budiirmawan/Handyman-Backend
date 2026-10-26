import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Additive, default-BLOCKED bridge. No issuer is enrolled by migration.
 * Historical personal decisions/receipts retain their exact meaning. */
export const migration0481HandymanCommercialConsentBridge: Migration = {
  id: '0481_handyman_commercial_consent_bridge',
  async up(c: PoolClient) {
    await c.query(`
      ALTER TABLE handyman_handoff_integrations
        ADD COLUMN commercial_consent_contract_ref TEXT
          CHECK (commercial_consent_contract_ref IS NULL OR length(btrim(commercial_consent_contract_ref)) BETWEEN 1 AND 200);
      ALTER TABLE handyman_care_communications ALTER COLUMN recorded_by_user_id DROP NOT NULL;
      ALTER TABLE handyman_care_communications ADD COLUMN recorded_by_care_actor_id UUID REFERENCES handyman_handoff_care_actors(id),
        ADD CONSTRAINT handyman_communication_recorder_check CHECK (num_nonnulls(recorded_by_user_id, recorded_by_care_actor_id) = 1);
      CREATE UNIQUE INDEX handyman_communication_care_key ON handyman_care_communications(recorded_by_care_actor_id, idempotency_key)
        WHERE recorded_by_care_actor_id IS NOT NULL;
      CREATE TABLE handyman_commercial_consent_receipts (
        id UUID PRIMARY KEY,
        integration_id UUID NOT NULL REFERENCES handyman_handoff_integrations(id),
        care_actor_id UUID NOT NULL REFERENCES handyman_handoff_care_actors(id),
        communication_id UUID NOT NULL UNIQUE REFERENCES handyman_care_communications(id),
        client_id UUID NOT NULL REFERENCES clients(id),
        handyman_request_id UUID NOT NULL REFERENCES handyman_service_requests(id),
        target_type TEXT NOT NULL CHECK (target_type IN ('QUOTATION_VERSION','BAST')),
        target_id UUID NOT NULL, target_digest TEXT NOT NULL CHECK (target_digest ~ '^[a-f0-9]{64}$'),
        decision TEXT NOT NULL CHECK (decision IN ('ACCEPT','REJECT')),
        assertion_id TEXT NOT NULL, assertion_hash TEXT NOT NULL CHECK (assertion_hash ~ '^[a-f0-9]{64}$'),
        assertion JSONB NOT NULL, contract_reference TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (integration_id, assertion_id), UNIQUE (id, care_actor_id)
      );
      CREATE FUNCTION handyman_commercial_consent_no_write() RETURNS trigger AS $$ BEGIN
        RAISE EXCEPTION 'Commercial consent receipts are immutable.'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_commercial_consent_no_write BEFORE UPDATE OR DELETE ON handyman_commercial_consent_receipts
        FOR EACH ROW EXECUTE FUNCTION handyman_commercial_consent_no_write();
      CREATE FUNCTION handyman_verified_communication_no_write() RETURNS trigger AS $$ DECLARE cid UUID; BEGIN
        IF TG_TABLE_NAME = 'handyman_care_communications' THEN cid := OLD.id;
        ELSIF TG_OP = 'INSERT' THEN cid := NEW.communication_id;
        ELSE cid := OLD.communication_id; END IF;
        IF TG_TABLE_NAME = 'handyman_care_communication_evidence' AND TG_OP = 'UPDATE' THEN
          IF EXISTS(SELECT 1 FROM handyman_commercial_consent_receipts WHERE communication_id = NEW.communication_id) THEN
            RAISE EXCEPTION 'Verified communication provenance is immutable.'; END IF; END IF;
        IF EXISTS(SELECT 1 FROM handyman_commercial_consent_receipts WHERE communication_id = cid) THEN
          RAISE EXCEPTION 'Verified communication provenance is immutable.'; END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_verified_communication_no_write BEFORE UPDATE OR DELETE ON handyman_care_communications
        FOR EACH ROW EXECUTE FUNCTION handyman_verified_communication_no_write();
      CREATE TRIGGER handyman_verified_communication_evidence_no_write BEFORE INSERT OR UPDATE OR DELETE ON handyman_care_communication_evidence
        FOR EACH ROW EXECUTE FUNCTION handyman_verified_communication_no_write();
      ALTER TABLE handyman_quotation_decisions ALTER COLUMN decided_by_user_id DROP NOT NULL;
      ALTER TABLE handyman_quotation_decisions
        ADD COLUMN decided_by_care_actor_id UUID REFERENCES handyman_handoff_care_actors(id),
        ADD COLUMN commercial_consent_id UUID,
        ADD FOREIGN KEY (commercial_consent_id, decided_by_care_actor_id) REFERENCES handyman_commercial_consent_receipts(id, care_actor_id),
        ADD CONSTRAINT handyman_quotation_decision_recorder_check CHECK (
          (decided_by_user_id IS NOT NULL AND decided_by_care_actor_id IS NULL AND commercial_consent_id IS NULL) OR
          (decided_by_user_id IS NULL AND decided_by_care_actor_id IS NOT NULL AND commercial_consent_id IS NOT NULL));
      ALTER TABLE handyman_execution_scopes ALTER COLUMN created_by_user_id DROP NOT NULL;
      ALTER TABLE handyman_execution_scopes
        ADD COLUMN created_by_care_actor_id UUID REFERENCES handyman_handoff_care_actors(id),
        ADD CONSTRAINT handyman_execution_scope_recorder_check CHECK (num_nonnulls(created_by_user_id, created_by_care_actor_id) = 1);
      ALTER TABLE handyman_bast_events ALTER COLUMN actor_user_id DROP NOT NULL;
      ALTER TABLE handyman_bast_events
        ADD COLUMN actor_care_actor_id UUID REFERENCES handyman_handoff_care_actors(id),
        ADD COLUMN commercial_consent_id UUID,
        ADD FOREIGN KEY (commercial_consent_id, actor_care_actor_id) REFERENCES handyman_commercial_consent_receipts(id, care_actor_id),
        ADD CONSTRAINT handyman_bast_recorder_check CHECK (
          (actor_user_id IS NOT NULL AND actor_care_actor_id IS NULL AND commercial_consent_id IS NULL) OR
          (actor_user_id IS NULL AND actor_care_actor_id IS NOT NULL AND commercial_consent_id IS NOT NULL AND event_type IN ('ACCEPT','REJECT')));
      CREATE FUNCTION handyman_commercial_decision_binding() RETURNS trigger AS $$ DECLARE r RECORD; request_id UUID; BEGIN
        IF NEW.commercial_consent_id IS NULL THEN RETURN NEW; END IF;
        SELECT * INTO STRICT r FROM handyman_commercial_consent_receipts WHERE id = NEW.commercial_consent_id;
        IF TG_TABLE_NAME = 'handyman_quotation_decisions' THEN
          SELECT handyman_request_id INTO request_id FROM handyman_quotations WHERE id = NEW.quotation_id;
          IF r.target_type <> 'QUOTATION_VERSION' OR r.target_id <> NEW.quotation_version_id OR r.handyman_request_id <> request_id OR
             r.decision <> (CASE WHEN NEW.decision = 'APPROVE' THEN 'ACCEPT' ELSE 'REJECT' END) THEN
            RAISE EXCEPTION 'Quotation consent target mismatch.'; END IF;
        ELSE
          SELECT handyman_request_id INTO request_id FROM handyman_execution_scopes WHERE id = NEW.execution_scope_id;
          IF r.target_type <> 'BAST' OR r.target_id <> NEW.bast_id OR r.handyman_request_id <> request_id OR r.decision <> NEW.event_type THEN
            RAISE EXCEPTION 'BAST consent target mismatch.'; END IF;
          IF (NEW.metadata #>> '{customerConsent,manifest,careConsent,id}') IS DISTINCT FROM r.id::text OR
             (NEW.metadata #>> '{customerConsent,manifest,careConsent,assertionHash}') IS DISTINCT FROM r.assertion_hash OR
             (NEW.metadata #> '{customerConsent,manifest,careConsent,assertion}') IS DISTINCT FROM r.assertion OR
             (NEW.metadata #>> '{customerConsent,manifest,careConsent,contractReference}') IS DISTINCT FROM r.contract_reference OR
             (NEW.metadata #>> '{customerConsent,manifest,careConsent,integrationId}') IS DISTINCT FROM r.integration_id::text OR
             (NEW.metadata #>> '{customerConsent,manifest,careConsent,careActorId}') IS DISTINCT FROM r.care_actor_id::text THEN
            RAISE EXCEPTION 'BAST consent receipt mismatch.'; END IF;
        END IF;
        IF r.client_id <> NEW.client_id THEN RAISE EXCEPTION 'Consent Client mismatch.'; END IF;
        RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE FUNCTION handyman_care_scope_creator_binding() RETURNS trigger AS $$ DECLARE d RECORD; BEGIN
        IF NEW.created_by_care_actor_id IS NULL THEN RETURN NEW; END IF;
        SELECT * INTO STRICT d FROM handyman_quotation_decisions WHERE id = NEW.quotation_decision_id;
        IF d.decided_by_care_actor_id IS DISTINCT FROM NEW.created_by_care_actor_id OR d.decision <> 'APPROVE' OR
           d.client_id <> NEW.client_id OR d.quotation_version_id <> NEW.approved_quotation_version_id THEN
          RAISE EXCEPTION 'Execution scope Care recorder must match its verified approval.'; END IF;
        RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_care_scope_creator_binding BEFORE INSERT ON handyman_execution_scopes
        FOR EACH ROW EXECUTE FUNCTION handyman_care_scope_creator_binding();
      -- The existing close-only scope guard predates nullable local creators.
      -- Preserve recorder identity with NULL-safe comparisons on every update.
      CREATE FUNCTION handyman_scope_recorder_no_change() RETURNS trigger AS $$ BEGIN
        IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR
           NEW.created_by_care_actor_id IS DISTINCT FROM OLD.created_by_care_actor_id THEN
          RAISE EXCEPTION 'Execution scope recorder provenance is immutable.'; END IF;
        RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_scope_recorder_no_change BEFORE UPDATE ON handyman_execution_scopes
        FOR EACH ROW EXECUTE FUNCTION handyman_scope_recorder_no_change();
      CREATE TRIGGER handyman_quotation_consent_binding BEFORE INSERT ON handyman_quotation_decisions FOR EACH ROW EXECUTE FUNCTION handyman_commercial_decision_binding();
      CREATE TRIGGER handyman_bast_consent_binding BEFORE INSERT ON handyman_bast_events FOR EACH ROW EXECUTE FUNCTION handyman_commercial_decision_binding();
    `);
  },
  async down(c: PoolClient) {
    // Never destroy legitimate actor/consent provenance to force a downgrade.
    await c.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM handyman_commercial_consent_receipts) OR
      EXISTS(SELECT 1 FROM handyman_care_communications WHERE recorded_by_care_actor_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot downgrade while Care consent/communication provenance exists.'; END IF; END $$;
      DROP TRIGGER handyman_quotation_consent_binding ON handyman_quotation_decisions;
      DROP TRIGGER handyman_bast_consent_binding ON handyman_bast_events;
      DROP FUNCTION handyman_commercial_decision_binding();
      DROP TRIGGER handyman_care_scope_creator_binding ON handyman_execution_scopes;
      DROP FUNCTION handyman_care_scope_creator_binding();
      DROP TRIGGER handyman_scope_recorder_no_change ON handyman_execution_scopes;
      DROP FUNCTION handyman_scope_recorder_no_change();
      ALTER TABLE handyman_bast_events DROP CONSTRAINT handyman_bast_recorder_check,
        DROP COLUMN commercial_consent_id, DROP COLUMN actor_care_actor_id, ALTER COLUMN actor_user_id SET NOT NULL;
      ALTER TABLE handyman_execution_scopes DROP CONSTRAINT handyman_execution_scope_recorder_check,
        DROP COLUMN created_by_care_actor_id, ALTER COLUMN created_by_user_id SET NOT NULL;
      ALTER TABLE handyman_quotation_decisions DROP CONSTRAINT handyman_quotation_decision_recorder_check,
        DROP COLUMN commercial_consent_id, DROP COLUMN decided_by_care_actor_id, ALTER COLUMN decided_by_user_id SET NOT NULL;
      DROP TRIGGER handyman_verified_communication_no_write ON handyman_care_communications;
      DROP TRIGGER handyman_verified_communication_evidence_no_write ON handyman_care_communication_evidence;
      DROP FUNCTION handyman_verified_communication_no_write();
      DROP TABLE handyman_commercial_consent_receipts; DROP FUNCTION handyman_commercial_consent_no_write();
      ALTER TABLE handyman_care_communications DROP CONSTRAINT handyman_communication_recorder_check,
        DROP COLUMN recorded_by_care_actor_id, ALTER COLUMN recorded_by_user_id SET NOT NULL;
      ALTER TABLE handyman_handoff_integrations DROP COLUMN commercial_consent_contract_ref;`);
  },
};
