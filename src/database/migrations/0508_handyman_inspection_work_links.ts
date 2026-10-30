import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Explicit lineage only: the existing fee, inspection, quotation and ledger
 * authorities remain on their own requests. A VERIFIED evidence upload means
 * the stored bytes were verified, not that a reviewer certified their content. */
export const migration0508HandymanInspectionWorkLinks: Migration = {
  id: '0508_handyman_inspection_work_links',
  async up(c: PoolClient): Promise<void> {
    await c.query(`
      CREATE TABLE handyman_inspection_work_links (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID NOT NULL REFERENCES buildings(id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies(id),
        space_id UUID REFERENCES spaces(id),
        inspection_request_id UUID NOT NULL UNIQUE REFERENCES handyman_service_requests(id),
        work_request_id UUID NOT NULL UNIQUE REFERENCES handyman_service_requests(id),
        inspection_id UUID NOT NULL REFERENCES handyman_request_inspections(id),
        evidence_upload_id UUID NOT NULL REFERENCES handyman_field_evidence_uploads(id),
        evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
        evidence_byte_size INTEGER NOT NULL CHECK (evidence_byte_size > 0),
        fee_execution_scope_id UUID NOT NULL REFERENCES handyman_execution_scopes(id),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK (inspection_request_id <> work_request_id)
      );

      CREATE FUNCTION hm_inspection_work_link_insert_guard() RETURNS trigger AS $$
      BEGIN
        -- Both writers use deterministic request locks, also preventing cycles.
        PERFORM id FROM handyman_service_requests
          WHERE id IN (NEW.inspection_request_id, NEW.work_request_id) ORDER BY id FOR UPDATE;
        PERFORM id FROM handyman_field_evidence_uploads WHERE id=NEW.evidence_upload_id FOR UPDATE;
        IF EXISTS (SELECT 1 FROM handyman_inspection_work_links l
          WHERE l.work_request_id=NEW.inspection_request_id OR l.inspection_request_id=NEW.work_request_id)
        THEN RAISE EXCEPTION 'Inspection/work links cannot form a chain or cycle.' USING ERRCODE='23514'; END IF;
        IF NOT EXISTS (
          SELECT 1 FROM handyman_service_requests p
          JOIN handyman_service_requests w ON w.id=NEW.work_request_id
            AND w.client_id=p.client_id AND w.building_id=p.building_id
            AND w.tenant_company_id=p.tenant_company_id AND w.space_id IS NOT DISTINCT FROM p.space_id
          JOIN handyman_request_inspections i ON i.id=NEW.inspection_id
            AND i.handyman_request_id=p.id AND i.client_id=p.client_id
            AND i.building_id=p.building_id AND i.channel_attribution_id=p.channel_attribution_id
            AND i.inspection_result='INSPECTED'
          JOIN handyman_field_evidence_uploads e ON e.id=NEW.evidence_upload_id
            AND e.client_id=p.client_id AND e.building_id=p.building_id
            AND e.tenant_company_id=p.tenant_company_id AND e.handyman_request_id=p.id
            AND e.execution_scope_id IS NULL AND e.purpose='INSPECTION_EVIDENCE'
            AND e.upload_status='VERIFIED' AND e.verified_at IS NOT NULL
            AND e.attachment_reference=('hm-ev://' || e.id::text)
            AND e.sha256_checksum=NEW.evidence_sha256 AND e.verified_byte_size=NEW.evidence_byte_size
          -- PAID_CREDITED's existing explicit credit writer is keyed to the
          -- inspected request, not its separate work child. Fail closed until
          -- that contract can recognize the link; never silently lose a credit.
          JOIN handyman_inspection_fee_terms ft ON ft.handyman_request_id=p.id
            AND ft.treatment='PAID_SEPARATE'
            AND ft.agreed_amount>0 AND ft.fee_execution_scope_id=NEW.fee_execution_scope_id
          JOIN handyman_execution_scopes s ON s.id=ft.fee_execution_scope_id
            AND s.client_id=p.client_id AND s.building_id=p.building_id
            AND s.tenant_company_id=p.tenant_company_id AND s.space_id IS NOT DISTINCT FROM p.space_id
            AND s.handyman_request_id<>p.id AND s.handyman_request_id<>w.id
          JOIN handyman_quotation_versions v ON v.id=s.approved_quotation_version_id AND v.status='APPROVED'
          JOIN handyman_quotations fq ON fq.id=v.quotation_id AND fq.id=s.quotation_id
            AND fq.handyman_request_id=s.handyman_request_id AND fq.client_id=p.client_id
          JOIN handyman_quotation_decisions d ON d.id=s.quotation_decision_id
            AND d.quotation_id=fq.id AND d.quotation_version_id=v.id AND d.client_id=p.client_id
            AND d.tenant_company_id=p.tenant_company_id AND d.decision='APPROVE'
          JOIN handyman_inspection_fee_offers o ON o.quotation_version_id=v.id
            AND o.handyman_request_id=p.id AND o.treatment=ft.treatment
            AND o.no_proceed_treatment=ft.no_proceed_treatment
          WHERE p.id=NEW.inspection_request_id AND p.client_id=NEW.client_id
            AND p.building_id=NEW.building_id AND p.tenant_company_id=NEW.tenant_company_id
            AND p.space_id IS NOT DISTINCT FROM NEW.space_id
            AND p.status IN ('DIAGNOSIS','READY_FOR_NEXT_STEP') AND w.status='INTAKE'
            AND ft.created_at <= i.inspected_at
            AND NOT EXISTS (SELECT 1 FROM handyman_quotations q WHERE q.handyman_request_id IN (p.id,w.id))
            AND (SELECT count(*) FROM handyman_quotation_lines ql WHERE ql.quotation_version_id=v.id)=1
            AND EXISTS (SELECT 1 FROM handyman_quotation_lines ql WHERE ql.quotation_version_id=v.id
              AND ql.line_type='LABOR' AND ql.line_total=ft.agreed_amount AND ql.currency=ft.currency)
        ) THEN RAISE EXCEPTION 'Inspection/work link requires the exact paid inspection, verified report and matching unquoted work request.' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_inspection_work_link_insert BEFORE INSERT ON handyman_inspection_work_links
        FOR EACH ROW EXECUTE FUNCTION hm_inspection_work_link_insert_guard();

      CREATE FUNCTION hm_inspection_work_link_immutable() RETURNS trigger AS $$ BEGIN
        IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM handyman_inspection_work_links) THEN RETURN NULL; END IF;
        RAISE EXCEPTION 'Inspection/work links are immutable.' USING ERRCODE='23514';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_inspection_work_link_no_write BEFORE UPDATE OR DELETE ON handyman_inspection_work_links
        FOR EACH ROW EXECUTE FUNCTION hm_inspection_work_link_immutable();
      CREATE TRIGGER hm_inspection_work_link_no_truncate BEFORE TRUNCATE ON handyman_inspection_work_links
        FOR EACH STATEMENT EXECUTE FUNCTION hm_inspection_work_link_immutable();
      CREATE FUNCTION hm_linked_inspection_evidence_immutable() RETURNS trigger AS $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_inspection_work_links WHERE evidence_upload_id=OLD.id) THEN
          RAISE EXCEPTION 'Linked inspection report evidence is immutable.' USING ERRCODE='23514';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_linked_inspection_evidence_no_write BEFORE UPDATE OR DELETE ON handyman_field_evidence_uploads
        FOR EACH ROW EXECUTE FUNCTION hm_linked_inspection_evidence_immutable();
      CREATE FUNCTION hm_linked_inspection_no_work_quote() RETURNS trigger AS $$ BEGIN
        PERFORM id FROM handyman_service_requests WHERE id=NEW.handyman_request_id FOR UPDATE;
        IF EXISTS (SELECT 1 FROM handyman_inspection_work_links WHERE inspection_request_id=NEW.handyman_request_id) THEN
          RAISE EXCEPTION 'Create the work quotation on the linked work request.' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER hm_linked_inspection_no_work_quote BEFORE INSERT ON handyman_quotations
        FOR EACH ROW EXECUTE FUNCTION hm_linked_inspection_no_work_quote();

      -- Fee approval creates the scope needed by the existing payment ledger,
      -- but that scope is not authority to schedule or perform repair work.
      CREATE FUNCTION hm_inspection_fee_no_work() RETURNS trigger AS $$
      BEGIN
        IF NEW.execution_scope_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM handyman_execution_scopes s
          JOIN handyman_inspection_fee_offers o ON o.quotation_version_id=s.approved_quotation_version_id
          WHERE s.id=NEW.execution_scope_id
        ) THEN
          IF TG_TABLE_NAME='handyman_execution_scope_assignments' THEN
            RAISE EXCEPTION 'Inspection fee approval does not authorize repair work.' USING ERRCODE='23514';
          ELSIF TG_TABLE_NAME='handyman_visit_appointments' THEN
            IF NEW.kind='EXECUTION' AND NEW.state<>'CANCELLED' THEN
              RAISE EXCEPTION 'Inspection fee approval does not authorize repair work.' USING ERRCODE='23514'; END IF;
          ELSIF TG_TABLE_NAME='handyman_dispatch_releases' THEN
            IF NEW.status IN ('RELEASED','IN_PROGRESS') THEN
              RAISE EXCEPTION 'Inspection fee approval does not authorize repair work.' USING ERRCODE='23514'; END IF;
          ELSIF TG_TABLE_NAME='handyman_work_sessions' THEN
            IF TG_OP='INSERT' OR NEW.status='IN_PROGRESS' THEN
              RAISE EXCEPTION 'Inspection fee approval does not authorize repair work.' USING ERRCODE='23514'; END IF;
          END IF;
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER aa_inspection_fee_no_assignment BEFORE INSERT ON handyman_execution_scope_assignments
        FOR EACH ROW EXECUTE FUNCTION hm_inspection_fee_no_work();
      CREATE TRIGGER aa_inspection_fee_no_execution_visit BEFORE INSERT OR UPDATE ON handyman_visit_appointments
        FOR EACH ROW EXECUTE FUNCTION hm_inspection_fee_no_work();
      CREATE TRIGGER aa_inspection_fee_no_dispatch BEFORE INSERT OR UPDATE ON handyman_dispatch_releases
        FOR EACH ROW EXECUTE FUNCTION hm_inspection_fee_no_work();
      CREATE TRIGGER aa_inspection_fee_no_work_session BEFORE INSERT OR UPDATE ON handyman_work_sessions
        FOR EACH ROW EXECUTE FUNCTION hm_inspection_fee_no_work();
    `);
  },
  async down(c: PoolClient): Promise<void> {
    await c.query(`
      LOCK TABLE handyman_inspection_work_links IN ACCESS EXCLUSIVE MODE;
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM handyman_inspection_work_links) THEN
        RAISE EXCEPTION 'Refusing to remove inspection/work lineage.'; END IF; END $$;
      DROP TRIGGER aa_inspection_fee_no_work_session ON handyman_work_sessions;
      DROP TRIGGER aa_inspection_fee_no_dispatch ON handyman_dispatch_releases;
      DROP TRIGGER aa_inspection_fee_no_execution_visit ON handyman_visit_appointments;
      DROP TRIGGER aa_inspection_fee_no_assignment ON handyman_execution_scope_assignments;
      DROP FUNCTION hm_inspection_fee_no_work();
      DROP TRIGGER hm_linked_inspection_no_work_quote ON handyman_quotations;
      DROP FUNCTION hm_linked_inspection_no_work_quote();
      DROP TRIGGER hm_linked_inspection_evidence_no_write ON handyman_field_evidence_uploads;
      DROP FUNCTION hm_linked_inspection_evidence_immutable();
      DROP TABLE handyman_inspection_work_links;
      DROP FUNCTION hm_inspection_work_link_insert_guard();
      DROP FUNCTION hm_inspection_work_link_immutable();
    `);
  },
};
