import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15E — Vendor Work ↔ Evidence binding.
 *
 * Reuses the existing BE-07 evidence engine (evidence_requirements +
 * evidence_submissions) rather than creating a duplicate Vendor evidence
 * engine. This migration only widens the two target/execution CHECK
 * constraints to admit a Vendor Work:
 *
 *   - evidence_requirements.target_type now accepts 'VENDOR_WORK' so a Vendor
 *     Work can carry PHOTO / DOCUMENT / SIGNATURE requirements.
 *   - evidence_submissions.execution_type now accepts 'VENDOR_WORK' so
 *     evidence can be bound to a Vendor Work (execution_id = vendor_work_id).
 *
 * All file metadata, MIME rules, evidence-count logic, and storage remain the
 * single BE-07 engine — nothing is duplicated here. Mirrors the BE-08G
 * WORK_ORDER widening precedent.
 */
export const migration0159AddVendorWorkEvidenceBinding: Migration = {
  id: '0159_add_vendor_work_evidence_binding',

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
             'CHECKLIST_TEMPLATE', 'CHECKLIST_ITEM', 'WORK_ORDER'))
    `);

    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution
    `);
    await client.query(`
      ALTER TABLE evidence_submissions
        ADD CONSTRAINT evidence_submission_execution
          CHECK (execution_type IN
            ('FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER'))
    `);
  },
};
