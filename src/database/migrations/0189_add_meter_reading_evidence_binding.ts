import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18F — Meter Reading ↔ Evidence binding.
 *
 * Reuses the existing BE-07 evidence engine (evidence_requirements +
 * evidence_submissions) rather than creating a separate utility evidence
 * engine. This migration only widens the two target/execution CHECK
 * constraints to admit a Meter Reading:
 *
 *   - evidence_requirements.target_type now accepts 'UTILITY_METER_READING'
 *     so a BE-18E reading can carry PHOTO / DOCUMENT / SIGNATURE
 *     requirements.
 *   - evidence_submissions.execution_type now accepts
 *     'UTILITY_METER_READING' so evidence can be bound to a reading
 *     (execution_id = utility_meter_reading id).
 *
 * All file metadata, MIME rules, evidence-count logic, the 50 MB size ceiling,
 * and the `file_reference` storage-pointer convention remain the single BE-07
 * engine — nothing is duplicated here, and no binary is stored in PostgreSQL.
 * Evidence history is preserved by BE-07's soft-remove rule
 * (`status → 'REMOVED'`); rows are never hard-deleted.
 *
 * Mirrors the BE-08G WORK_ORDER and BE-15E VENDOR_WORK widening precedents.
 * No new table is required for BE-18F.
 */
export const migration0189AddMeterReadingEvidenceBinding: Migration = {
  id: '0189_add_meter_reading_evidence_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_requirements
        DROP CONSTRAINT evidence_target
    `);
    await client.query(`
      ALTER TABLE evidence_requirements
        ADD CONSTRAINT evidence_target
          CHECK (target_type IN
            ('FORM_TEMPLATE', 'FORM_VERSION', 'FORM_SECTION', 'FORM_FIELD',
             'CHECKLIST_TEMPLATE', 'CHECKLIST_ITEM', 'WORK_ORDER',
             'VENDOR_WORK', 'UTILITY_METER_READING'))
    `);

    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution
    `);
    await client.query(`
      ALTER TABLE evidence_submissions
        ADD CONSTRAINT evidence_submission_execution
          CHECK (execution_type IN
            ('FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
             'VENDOR_WORK', 'UTILITY_METER_READING'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_requirements
        DROP CONSTRAINT evidence_target
    `);
    await client.query(`
      ALTER TABLE evidence_requirements
        ADD CONSTRAINT evidence_target
          CHECK (target_type IN
            ('FORM_TEMPLATE', 'FORM_VERSION', 'FORM_SECTION', 'FORM_FIELD',
             'CHECKLIST_TEMPLATE', 'CHECKLIST_ITEM', 'WORK_ORDER',
             'VENDOR_WORK'))
    `);

    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution
    `);
    await client.query(`
      ALTER TABLE evidence_submissions
        ADD CONSTRAINT evidence_submission_execution
          CHECK (execution_type IN
            ('FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
             'VENDOR_WORK'))
    `);
  },
};
