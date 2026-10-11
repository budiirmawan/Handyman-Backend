import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** PART C: additive provenance only; never backfill or rewrite 0382 history. */
export const migration0447HandymanDiagnosisInspectionSource: Migration = {
  id: '0447_handyman_diagnosis_inspection_source',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_request_diagnoses
        ADD COLUMN source_inspection_report_id UUID,
        ADD CONSTRAINT handyman_diagnosis_inspection_source_fk
          FOREIGN KEY (source_inspection_report_id, handyman_request_id)
          REFERENCES handyman_request_inspection_reports (id, handyman_request_id)
    `);
    // INSERT-only: historical null links stay valid and immutable. Together
    // with the same-request FK, defend provenance outside the service too.
    await client.query(`
      CREATE FUNCTION handyman_diagnosis_inspection_source_guard()
      RETURNS trigger AS $$
      BEGIN
        PERFORM 1 FROM handyman_service_requests
          WHERE id = NEW.handyman_request_id FOR UPDATE;
        IF NEW.source_inspection_report_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM handyman_request_triage_decisions
          WHERE handyman_request_id = NEW.handyman_request_id
            AND triage_disposition = 'INSPECTION_REQUIRED'
        ) THEN
          IF NEW.source_inspection_report_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM handyman_request_inspection_reports rp
            JOIN handyman_request_inspection_report_reviews rv ON rv.report_id = rp.id
            WHERE rp.id = NEW.source_inspection_report_id
              AND rp.handyman_request_id = NEW.handyman_request_id
              AND rv.handyman_request_id = NEW.handyman_request_id
              AND rv.decision = 'ACCEPTED'
              AND NOT EXISTS (
                SELECT 1 FROM handyman_request_inspection_reports later
                WHERE later.handyman_request_id = rp.handyman_request_id
                  AND later.version_number > rp.version_number
              )
          ) THEN
            RAISE EXCEPTION 'Diagnosis requires the latest accepted same-request inspection report.'
              USING ERRCODE = '23514',
                CONSTRAINT = 'handyman_diagnosis_accepted_inspection_source';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER handyman_diagnosis_inspection_source_insert
        BEFORE INSERT ON handyman_request_diagnoses
        FOR EACH ROW EXECUTE FUNCTION handyman_diagnosis_inspection_source_guard()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_diagnosis_inspection_source_insert
        ON handyman_request_diagnoses;
      DROP FUNCTION IF EXISTS handyman_diagnosis_inspection_source_guard();
      ALTER TABLE handyman_request_diagnoses
        DROP CONSTRAINT IF EXISTS handyman_diagnosis_inspection_source_fk,
        DROP COLUMN IF EXISTS source_inspection_report_id
    `);
  },
};
