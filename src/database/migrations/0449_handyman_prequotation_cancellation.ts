import type { PoolClient } from 'pg';
import type { Migration } from './types';

const guardedTables = [
  'handyman_request_triage_decisions', 'handyman_request_inspections',
  'handyman_request_inspection_assignments', 'handyman_request_inspection_reports',
  'handyman_request_inspection_report_reviews', 'handyman_request_diagnoses',
  'handyman_request_referrals', 'handyman_quotations', 'handyman_quotation_versions',
  'handyman_request_inspection_report_estimates', 'handyman_scheduling_readiness',
  'handyman_unit_access_readiness', 'handyman_permit_readiness', 'handyman_service_request_contacts',
];

/** Owner-authorized terminal pre-quotation disposition. Never a PIC decision. */
export const migration0449HandymanPrequotationCancellation: Migration = {
  id: '0449_handyman_prequotation_cancellation',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_service_requests DROP CONSTRAINT handyman_service_requests_status_check;
      ALTER TABLE handyman_service_requests ADD CONSTRAINT handyman_service_requests_status_check
        CHECK(status IN ('INTAKE','TRIAGE','INSPECTION_REQUIRED','DIAGNOSIS','READY_FOR_NEXT_STEP','REFERRED','CANCELLED_PRE_QUOTATION'));
      CREATE TABLE handyman_prequotation_cancellations (
        handyman_request_id UUID PRIMARY KEY REFERENCES handyman_service_requests(id),
        reason TEXT NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 10 AND 1000),
        cancelled_by_user_id UUID NOT NULL REFERENCES users(id),
        cancelled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE handyman_cancelled_request_predecessors (
        handyman_request_id UUID PRIMARY KEY REFERENCES handyman_service_requests(id),
        cancelled_request_id UUID NOT NULL REFERENCES handyman_prequotation_cancellations(handyman_request_id),
        linked_by_user_id UUID NOT NULL REFERENCES users(id),
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK(handyman_request_id <> cancelled_request_id)
      );
      CREATE FUNCTION handyman_prequotation_history_immutable() RETURNS trigger AS $$ BEGIN
        RAISE EXCEPTION 'Pre-quotation Operations history is append-only.';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER cancellation_immutable BEFORE UPDATE OR DELETE ON handyman_prequotation_cancellations
        FOR EACH ROW EXECUTE FUNCTION handyman_prequotation_history_immutable();
      CREATE TRIGGER cancelled_predecessor_immutable BEFORE UPDATE OR DELETE ON handyman_cancelled_request_predecessors
        FOR EACH ROW EXECUTE FUNCTION handyman_prequotation_history_immutable();

      CREATE FUNCTION handyman_cancellation_insert_guard() RETURNS trigger AS $$
      DECLARE r handyman_service_requests%ROWTYPE;
      BEGIN
        SELECT * INTO r FROM handyman_service_requests WHERE id=NEW.handyman_request_id FOR UPDATE;
        IF r.status IN ('REFERRED','CANCELLED_PRE_QUOTATION') OR EXISTS (
          SELECT 1 FROM handyman_quotations WHERE handyman_request_id=r.id
        ) OR EXISTS (SELECT 1 FROM handyman_execution_scopes WHERE handyman_request_id=r.id) THEN
          RAISE EXCEPTION 'Cancellation requires an open pre-quotation request.' USING ERRCODE='23514', CONSTRAINT='handyman_cancellation_not_eligible';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER cancellation_insert BEFORE INSERT ON handyman_prequotation_cancellations
        FOR EACH ROW EXECUTE FUNCTION handyman_cancellation_insert_guard();
      CREATE FUNCTION handyman_cancellation_projection_guard() RETURNS trigger AS $$ BEGIN
        IF OLD.status='CANCELLED_PRE_QUOTATION' THEN
          RAISE EXCEPTION 'Cancelled Handyman requests cannot be changed or reopened.' USING ERRCODE='23514', CONSTRAINT='handyman_prequotation_cancelled';
        END IF;
        IF NEW.status='CANCELLED_PRE_QUOTATION' AND NOT EXISTS (
          SELECT 1 FROM handyman_prequotation_cancellations WHERE handyman_request_id=NEW.id
        ) THEN
          RAISE EXCEPTION 'Cancellation requires its Operations decision.' USING ERRCODE='23514', CONSTRAINT='handyman_cancellation_not_eligible';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER cancellation_projection BEFORE INSERT OR UPDATE OR DELETE ON handyman_service_requests
        FOR EACH ROW EXECUTE FUNCTION handyman_cancellation_projection_guard();

      CREATE FUNCTION handyman_cancellation_project() RETURNS trigger AS $$ BEGIN
        UPDATE handyman_service_requests SET status='CANCELLED_PRE_QUOTATION', updated_at=NOW()
          WHERE id=NEW.handyman_request_id;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER cancellation_project AFTER INSERT ON handyman_prequotation_cancellations
        FOR EACH ROW EXECUTE FUNCTION handyman_cancellation_project();
      CREATE FUNCTION handyman_cancelled_request_write_guard() RETURNS trigger AS $$
      DECLARE request_id UUID; request_status TEXT;
      BEGIN
        IF TG_TABLE_NAME='evidence_submissions' THEN
          IF NEW.execution_type <> 'HANDYMAN_REQUEST' THEN RETURN NEW; END IF;
          request_id := NEW.execution_id;
        ELSIF TG_TABLE_NAME='handyman_quotation_versions' THEN
          SELECT handyman_request_id INTO request_id FROM handyman_quotations WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.quotation_id ELSE NEW.quotation_id END;
        ELSIF TG_TABLE_NAME='handyman_request_inspection_report_estimates' THEN
          SELECT handyman_request_id INTO request_id FROM handyman_request_inspection_reports WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.report_id ELSE NEW.report_id END;
        ELSE request_id := CASE WHEN TG_OP='DELETE' THEN OLD.handyman_request_id ELSE NEW.handyman_request_id END;
        END IF;
        IF TG_OP='UPDATE' AND (
          (to_jsonb(NEW)->>'handyman_request_id') IS DISTINCT FROM (to_jsonb(OLD)->>'handyman_request_id') OR
          (to_jsonb(NEW)->>'quotation_id') IS DISTINCT FROM (to_jsonb(OLD)->>'quotation_id') OR
          (to_jsonb(NEW)->>'report_id') IS DISTINCT FROM (to_jsonb(OLD)->>'report_id')
        ) THEN RAISE EXCEPTION 'Pre-quotation facts cannot be reparented.' USING ERRCODE='23514'; END IF;
        SELECT status INTO request_status FROM handyman_service_requests WHERE id=request_id FOR UPDATE;
        IF request_status='CANCELLED_PRE_QUOTATION' OR EXISTS (
          SELECT 1 FROM handyman_prequotation_cancellations WHERE handyman_request_id=request_id
        ) THEN
          RAISE EXCEPTION 'Handyman request is cancelled before quotation.' USING ERRCODE='23514', CONSTRAINT='handyman_prequotation_cancelled';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER prequotation_cancelled_evidence_guard BEFORE INSERT ON evidence_submissions
        FOR EACH ROW EXECUTE FUNCTION handyman_cancelled_request_write_guard();
      CREATE FUNCTION handyman_cancelled_predecessor_guard() RETURNS trigger AS $$
      DECLARE r handyman_service_requests%ROWTYPE; previous handyman_service_requests%ROWTYPE;
      BEGIN
        SELECT * INTO r FROM handyman_service_requests WHERE id=NEW.handyman_request_id FOR UPDATE;
        SELECT * INTO previous FROM handyman_service_requests WHERE id=NEW.cancelled_request_id;
        IF r.status <> 'INTAKE' OR previous.status <> 'CANCELLED_PRE_QUOTATION'
          OR r.client_id <> previous.client_id OR r.building_id <> previous.building_id THEN
          RAISE EXCEPTION 'A new intake may reference only a cancelled request in its exact scope.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER cancelled_predecessor_insert BEFORE INSERT ON handyman_cancelled_request_predecessors
        FOR EACH ROW EXECUTE FUNCTION handyman_cancelled_predecessor_guard();
    `);
    for (const table of guardedTables) await client.query(`CREATE TRIGGER prequotation_cancelled_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION handyman_cancelled_request_write_guard()`);
  },
  async down(client: PoolClient): Promise<void> {
    // Never erase authoritative cancellation history to make rollback possible.
    await client.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM handyman_prequotation_cancellations) THEN
      RAISE EXCEPTION 'Cannot remove cancellation authority with recorded history.'; END IF; END $$`);
    for (const table of guardedTables) await client.query(`DROP TRIGGER prequotation_cancelled_guard ON ${table}`);
    await client.query(`
      DROP TABLE handyman_cancelled_request_predecessors;
      DROP TABLE handyman_prequotation_cancellations;
      DROP TRIGGER cancellation_projection ON handyman_service_requests;
      DROP FUNCTION handyman_cancellation_projection_guard();
      DROP FUNCTION handyman_cancellation_project();
      DROP FUNCTION handyman_cancelled_predecessor_guard();
      DROP TRIGGER prequotation_cancelled_evidence_guard ON evidence_submissions;
      DROP FUNCTION handyman_cancelled_request_write_guard();
      DROP FUNCTION handyman_cancellation_insert_guard();
      DROP FUNCTION handyman_prequotation_history_immutable();
      ALTER TABLE handyman_service_requests DROP CONSTRAINT handyman_service_requests_status_check;
      ALTER TABLE handyman_service_requests ADD CONSTRAINT handyman_service_requests_status_check
        CHECK(status IN ('INTAKE','TRIAGE','INSPECTION_REQUIRED','DIAGNOSIS','READY_FOR_NEXT_STEP','REFERRED'));
    `);
  },
};
