import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08I — Work Order Verification / Rework / Closure binding.
 *
 * Reuses the BE-07 Review & Verification primitive (`reviews`) instead of
 * creating a separate Work Order verification engine. This migration only
 * widens `reviews.target_type` to admit a Work Order:
 *
 *   - reviews.target_type now accepts 'WORK_ORDER' so a COMPLETED Work Order
 *     can carry APPROVED / REJECTED / REWORK_REQUIRED verification decisions.
 *
 * The review's `decision`, `notes`, `reviewer_user_id`, `status`
 * (PENDING/COMPLETED), and `reviewed_at` columns already encode everything a
 * Work Order verification needs — nothing is duplicated.
 */
export const migration0089AddWorkOrderVerification: Migration = {
  id: '0089_add_work_order_verification',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE reviews
        DROP CONSTRAINT review_target
    `);
    await client.query(`
      ALTER TABLE reviews
        ADD CONSTRAINT review_target
          CHECK (target_type IN
            ('FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE reviews
        DROP CONSTRAINT review_target
    `);
    await client.query(`
      ALTER TABLE reviews
        ADD CONSTRAINT review_target
          CHECK (target_type IN ('FORM_INSTANCE', 'CHECKLIST_EXECUTION'))
    `);
  },
};
