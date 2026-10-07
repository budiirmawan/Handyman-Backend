import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20J — Permit ↔ shared BE-07 Evidence binding.
 *
 * No Permit evidence tables are created. The existing requirement/submission
 * target vocabularies are widened so Permit evidence keeps the BE-07 file
 * reference, metadata, count limits and soft-removal history conventions.
 */
export const migration0211AddPermitEvidenceBinding: Migration = {
  id: '0211_add_permit_evidence_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_requirements DROP CONSTRAINT evidence_target;
      ALTER TABLE evidence_requirements ADD CONSTRAINT evidence_target CHECK (
        target_type IN (
          'FORM_TEMPLATE', 'FORM_VERSION', 'FORM_SECTION', 'FORM_FIELD',
          'CHECKLIST_TEMPLATE', 'CHECKLIST_ITEM', 'WORK_ORDER', 'VENDOR_WORK',
          'UTILITY_METER_READING', 'PERMIT'
        )
      )
    `);
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution;
      ALTER TABLE evidence_submissions
        ADD CONSTRAINT evidence_submission_execution CHECK (
          execution_type IN (
            'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
            'VENDOR_WORK', 'UTILITY_METER_READING', 'PERMIT'
          )
        )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      "DELETE FROM evidence_submissions WHERE execution_type = 'PERMIT'",
    );
    await client.query(
      "DELETE FROM evidence_requirements WHERE target_type = 'PERMIT'",
    );
    await client.query(`
      ALTER TABLE evidence_requirements DROP CONSTRAINT evidence_target;
      ALTER TABLE evidence_requirements ADD CONSTRAINT evidence_target CHECK (
        target_type IN (
          'FORM_TEMPLATE', 'FORM_VERSION', 'FORM_SECTION', 'FORM_FIELD',
          'CHECKLIST_TEMPLATE', 'CHECKLIST_ITEM', 'WORK_ORDER', 'VENDOR_WORK',
          'UTILITY_METER_READING'
        )
      )
    `);
    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution;
      ALTER TABLE evidence_submissions
        ADD CONSTRAINT evidence_submission_execution CHECK (
          execution_type IN (
            'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
            'VENDOR_WORK', 'UTILITY_METER_READING'
          )
        )
    `);
  },
};
