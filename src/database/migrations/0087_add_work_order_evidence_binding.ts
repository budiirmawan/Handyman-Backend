import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08G — Work Order ↔ Evidence binding.
 *
 * Reuses the existing BE-07 evidence engine (evidence_requirements +
 * evidence_submissions) rather than creating a duplicate Work Order evidence
 * engine. This migration only widens the two target/execution CHECK
 * constraints to admit a Work Order:
 *
 *   - evidence_requirements.target_type now accepts 'WORK_ORDER' so a Work
 *     Order can carry PHOTO / DOCUMENT / SIGNATURE requirements.
 *   - evidence_submissions.execution_type now accepts 'WORK_ORDER' so
 *     evidence can be bound to a Work Order (execution_id = work_order_id).
 *
 * All file metadata, MIME rules, evidence-count logic, and storage remain the
 * single BE-07 engine — nothing is duplicated here.
 */
export const migration0087AddWorkOrderEvidenceBinding: Migration = {
  id: '0087_add_work_order_evidence_binding',

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
             'CHECKLIST_TEMPLATE', 'CHECKLIST_ITEM'))
    `);

    await client.query(`
      ALTER TABLE evidence_submissions
        DROP CONSTRAINT evidence_submission_execution
    `);
    await client.query(`
      ALTER TABLE evidence_submissions
        ADD CONSTRAINT evidence_submission_execution
          CHECK (execution_type IN ('FORM_INSTANCE', 'CHECKLIST_EXECUTION'))
    `);
  },
};
