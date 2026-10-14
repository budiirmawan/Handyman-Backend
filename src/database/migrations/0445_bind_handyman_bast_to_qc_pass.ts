import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** Add QC provenance to the EXISTING BAST document. NULL on historic BASTs is
 * intentional: an old PREPARE never becomes a fabricated Supervisor approval.
 * Only new PREPARE records must carry a current, guarded QC PASS. */
export const migration0445BindHandymanBastToQcPass: Migration = {
  id: '0445_bind_handyman_bast_to_qc_pass',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
      ALTER TABLE handyman_bast_documents ADD COLUMN qc_run_id UUID
        REFERENCES handyman_qc_runs(id);
      CREATE OR REPLACE FUNCTION handyman_bast_qc_pass_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE needs_qc_guard BOOLEAN := false;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          needs_qc_guard := true;
        ELSIF TG_OP = 'UPDATE' THEN
          IF NEW.qc_run_id IS DISTINCT FROM OLD.qc_run_id THEN
            RAISE EXCEPTION 'BAST QC run provenance is immutable'
              USING ERRCODE = '23514';
          END IF;
          needs_qc_guard := NEW.status IS DISTINCT FROM OLD.status
            AND NEW.status IN ('ISSUED', 'ACCEPTED');
        END IF;
        IF needs_qc_guard THEN
          IF NEW.qc_run_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM handyman_qc_runs r
            JOIN handyman_qc_checklist_specs s
              ON s.execution_scope_id = r.execution_scope_id
             AND s.client_id = r.client_id
             AND s.checklist_identity = r.checklist_identity
            JOIN handyman_qc_scope_checklist_bindings b
              ON b.execution_scope_id = s.execution_scope_id
             AND b.bound_at <= r.created_at
            JOIN handyman_qc_checklist_versions v
              ON v.id = b.checklist_version_id
             AND v.client_id = r.client_id
             AND v.required_item_keys = s.required_item_keys
            WHERE r.id = NEW.qc_run_id
              AND r.execution_scope_id = NEW.execution_scope_id
              AND r.client_id = NEW.client_id
              AND r.status = 'PASSED'
              AND r.id = (SELECT latest.id FROM handyman_qc_runs latest
                WHERE latest.execution_scope_id = r.execution_scope_id
                ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
              AND EXISTS (SELECT 1 FROM handyman_qc_run_events e
                WHERE e.run_id = r.id AND e.event_type = 'FINISH'
                  AND e.metadata->>'outcome' = 'PASSED'
                  AND e.metadata->>'templateVersionId' = v.id::text)
              AND (SELECT count(*) FROM handyman_qc_run_items i
                WHERE i.run_id = r.id) = cardinality(s.required_item_keys)
              AND NOT EXISTS (SELECT 1 FROM handyman_qc_run_items i
                WHERE i.run_id = r.id
                  AND (i.outcome <> 'PASS'
                    OR NOT i.item_key = ANY(s.required_item_keys)))
              AND EXISTS (SELECT 1 FROM handyman_qc_run_evidence qe
                JOIN handyman_field_evidence_uploads u
                  ON u.id = qe.evidence_upload_id
                WHERE qe.run_id = r.id AND u.execution_scope_id = r.execution_scope_id
                  AND u.client_id = r.client_id
                  AND u.purpose = 'QC_EVIDENCE' AND u.upload_status = 'VERIFIED')
              AND EXISTS (SELECT 1 FROM handyman_work_sessions ws
                WHERE ws.execution_scope_id = r.execution_scope_id
                  AND ws.client_id = r.client_id)
              AND NOT EXISTS (SELECT 1 FROM handyman_work_sessions ws
                WHERE ws.execution_scope_id = r.execution_scope_id
                  AND ws.client_id = r.client_id
                  AND (ws.status NOT IN ('COMPLETED', 'CHECKED_OUT')
                    OR ws.completed_at IS NULL))
              AND NOT EXISTS (SELECT 1 FROM handyman_defect_records d
                WHERE d.execution_scope_id = r.execution_scope_id
                  AND d.status <> 'VERIFIED')
          ) THEN
            RAISE EXCEPTION 'BAST PREPARE/ISSUE/ACCEPT requires current guarded QC PASS'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER handyman_bast_qc_pass_guard_trigger
        BEFORE INSERT OR UPDATE ON handyman_bast_documents
        FOR EACH ROW EXECUTE FUNCTION handyman_bast_qc_pass_guard();
    `);
  },
  async down(tx: PoolClient): Promise<void> {
    await tx.query(`
      DROP TRIGGER handyman_bast_qc_pass_guard_trigger
        ON handyman_bast_documents;
      DROP FUNCTION handyman_bast_qc_pass_guard();
      ALTER TABLE handyman_bast_documents DROP COLUMN qc_run_id;
    `);
  },
};
