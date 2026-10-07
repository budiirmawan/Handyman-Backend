import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-09F — bind Findings to the shared BE-07 reviews primitive. */
export const migration0095AddFindingReviews: Migration = {
  id: '0095_add_finding_reviews',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (
          'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER', 'FINDING'
        )
      );
      CREATE UNIQUE INDEX finding_pending_review_unique
        ON reviews (target_id)
        WHERE target_type = 'FINDING' AND status = 'PENDING';
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS finding_pending_review_unique;
      DELETE FROM reviews WHERE target_type = 'FINDING';
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN ('FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER')
      );
    `);
  },
};
