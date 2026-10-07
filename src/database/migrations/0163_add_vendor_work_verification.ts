import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15I — Vendor Work Verification binding.
 *
 * Reuses the BE-07 Review & Verification primitive (`reviews`) instead of
 * creating a separate Vendor verification engine. This migration only widens
 * `reviews.target_type` to admit a Vendor Work:
 *
 *   - reviews.target_type now accepts 'VENDOR_WORK' so a COMPLETED Vendor Work
 *     can carry APPROVED / REJECTED / REWORK_REQUIRED verification decisions.
 *
 * The review's `decision`, `notes`, `reviewer_user_id`, `status`
 * (PENDING/COMPLETED), and `reviewed_at` columns already encode everything a
 * Vendor Work verification needs — nothing is duplicated. Mirrors the BE-08I
 * WORK_ORDER widening precedent.
 */
export const migration0163AddVendorWorkVerification: Migration = {
  id: '0163_add_vendor_work_verification',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE reviews
        DROP CONSTRAINT review_target
    `);
    await client.query(`
      ALTER TABLE reviews
        ADD CONSTRAINT review_target
          CHECK (target_type IN
            ('FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER',
             'VENDOR_WORK'))
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
          CHECK (target_type IN
            ('FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER'))
    `);
  },
};
