import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-BE-EVD-01 PART 01 — shared Evidence parent kinds for BE-09. */
export const migration0277AddFindingEvidenceParents: Migration = {
  id: '0277_add_finding_evidence_parents',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE evidence_submissions DROP CONSTRAINT evidence_submission_execution;
      ALTER TABLE evidence_submissions ADD CONSTRAINT evidence_submission_execution CHECK (
        execution_type IN (
          'FORM_INSTANCE', 'CHECKLIST_EXECUTION',
          'FINDING', 'FINDING_REWORK', 'FINDING_VERIFICATION'
        )
      );
      CREATE INDEX evidence_submissions_finding_parent_idx
        ON evidence_submissions (execution_type, execution_id, status)
        WHERE execution_type IN ('FINDING', 'FINDING_REWORK', 'FINDING_VERIFICATION');
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS evidence_submissions_finding_parent_idx;
      DELETE FROM evidence_submissions
        WHERE execution_type IN ('FINDING', 'FINDING_REWORK', 'FINDING_VERIFICATION');
      ALTER TABLE evidence_submissions DROP CONSTRAINT evidence_submission_execution;
      ALTER TABLE evidence_submissions ADD CONSTRAINT evidence_submission_execution CHECK (
        execution_type IN ('FORM_INSTANCE', 'CHECKLIST_EXECUTION')
      );
    `);
  },
};
