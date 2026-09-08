import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18K — Utility Verification binding.
 *
 * Reuses the BE-07 Review & Verification primitive (`reviews`) instead of
 * creating a separate Utility verification engine. This migration only widens
 * `reviews.target_type` to admit an abnormal consumption:
 *
 *   - reviews.target_type now accepts 'UTILITY_ABNORMAL_CONSUMPTION' so a
 *     BE-18J detection can carry APPROVED / REJECTED / REWORK_REQUIRED
 *     verification decisions.
 *
 * No new table. The review row's `client_id`, `reviewer_user_id`, `decision`,
 * `notes`, `status` (PENDING/COMPLETED) and `reviewed_at` columns already
 * encode everything a utility verification needs, and `target_id` carries the
 * abnormal-consumption reference. The utility/meter context is resolved
 * through that reference from BE-18J → BE-18G → BE-18A rather than copied.
 * Mirrors the BE-08I WORK_ORDER, BE-09F FINDING and BE-15I VENDOR_WORK
 * widening precedents exactly.
 *
 * A partial UNIQUE index keeps at most one PENDING review per abnormal
 * consumption, matching the BE-09F `finding_pending_review_unique` precedent:
 * opening a second concurrent review of the same detection would produce two
 * competing verdicts. COMPLETED rows are exempt, so full verification history
 * accumulates and a completed decision is never overwritten in place.
 *
 * Out of scope, deliberately: Tenant Approval Binding (BE-18L).
 */
export const migration0193AddUtilityVerification: Migration = {
  id: '0193_add_utility_verification',

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
             'VENDOR_WORK', 'UTILITY_ABNORMAL_CONSUMPTION'))
    `);
    await client.query(`
      CREATE UNIQUE INDEX utility_abnormal_pending_review_unique
        ON reviews (target_id)
        WHERE target_type = 'UTILITY_ABNORMAL_CONSUMPTION'
          AND status = 'PENDING'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP INDEX IF EXISTS utility_abnormal_pending_review_unique',
    );
    await client.query(
      "DELETE FROM reviews WHERE target_type = 'UTILITY_ABNORMAL_CONSUMPTION'",
    );
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
};
