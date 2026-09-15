import type { PoolClient } from 'pg';
import { REVIEW_TARGET_UNION } from './0213_restore_review_target_union';
import type { Migration } from './types';

/**
 * BE-21J — Corrective Action Verification.
 *
 * NO NEW VERIFICATION ENGINE IS CREATED HERE.
 *
 * Verification records live in the shared BE-07 `reviews` table, exactly as
 * BE-09F binds Findings to it (migration 0095). This migration therefore adds
 * NO verification table: it only (a) admits a new review target, and (b)
 * teaches `corrective_actions` about the one new lifecycle state a successful
 * verification produces.
 *
 * The shared table already carries everything this PART needs — reviewer,
 * decision (`APPROVED` / `REJECTED` / `REWORK_REQUIRED`), notes, `reviewed_at`,
 * and a PENDING/COMPLETED status — so duplicating it would create a second
 * source of truth for "was this verified", which is precisely what the
 * governance rule forbids.
 *
 * REVIEW TARGET
 * -------------
 * Following the forward rule stated in 0213: this ADDS to the union and never
 * restates a subset. `'CORRECTIVE_ACTION'` is introduced here — by the PART
 * that actually writes it — and not earlier. The partial unique index mirrors
 * `finding_pending_review_unique`: at most one PENDING verification per
 * corrective action, enforced by the database rather than by a read-then-write
 * race in application code.
 *
 * THE `VERIFIED` STATUS
 * ---------------------
 * A successful verification is a real lifecycle outcome, so it is a status on
 * the action rather than something callers must infer by joining `reviews`.
 * Three existing CHECK constraints have to learn about it, and getting any of
 * them wrong would make the new status unreachable:
 *
 *   `..._status_check`      — must admit 'VERIFIED' at all.
 *   `..._approval_check`    — VERIFIED is reachable only THROUGH approval, so
 *                             it must keep approval metadata. Without this,
 *                             VERIFIED would fall through to the CANCELLED
 *                             branch and be rejected.
 *   `..._completion_check`  — a verified action was necessarily completed
 *                             first, so it must RETAIN `completed_at`. The
 *                             original constraint demanded `completed_at IS
 *                             NULL` for every non-COMPLETED status, which
 *                             would have made VERIFIED impossible.
 *
 * `verified_at` / `verified_by_user_id` mirror the table's existing
 * transition-metadata convention (`approved_*`, `completed_*`): the decision
 * itself and its full history live in `reviews`, while the row keeps enough
 * to answer "when was this verified, and by whom" without a join.
 *
 * REWORK returns the action to IN_PROGRESS and CLEARS the completion
 * metadata, because the completion claim has been withdrawn — the constraint
 * above would reject the row otherwise, and leaving a stale `completed_at` on
 * work that is being redone would be a lie. Nothing is lost: the completion,
 * the verification, and the rework decision are all preserved in `reviews`
 * and in the BE-07 event log.
 *
 * CLOSURE (BE-21K) IS NOT IMPLEMENTED HERE. VERIFIED is terminal in this
 * PART; a later one may extend the lifecycle past it.
 */

const REVIEW_TARGETS_WITH_CORRECTIVE_ACTION = [
  ...REVIEW_TARGET_UNION,
  'CORRECTIVE_ACTION',
] as const;

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

export const migration0222AddCorrectiveActionVerification: Migration = {
  id: '0222_add_corrective_action_verification',

  async up(client: PoolClient): Promise<void> {
    // (a) Admit the new review target — additive, per the 0213 forward rule.
    await client.query(`
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (${sqlList(REVIEW_TARGETS_WITH_CORRECTIVE_ACTION)})
      );
    `);

    // At most one open verification per corrective action, enforced by the
    // database so concurrent opens cannot both succeed.
    await client.query(`
      CREATE UNIQUE INDEX corrective_action_pending_review_unique
        ON reviews (target_id)
        WHERE target_type = 'CORRECTIVE_ACTION' AND status = 'PENDING'
    `);

    // (b) The one new lifecycle state a successful verification produces.
    await client.query(`
      ALTER TABLE corrective_actions
        ADD COLUMN verified_at          TIMESTAMPTZ,
        ADD COLUMN verified_by_user_id  UUID REFERENCES users (id)
    `);

    await client.query(`
      ALTER TABLE corrective_actions DROP CONSTRAINT corrective_actions_status_check;
      ALTER TABLE corrective_actions ADD CONSTRAINT corrective_actions_status_check
        CHECK (status IN (
          'PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED',
          'REJECTED', 'CANCELLED'
        ));
    `);

    // VERIFIED is reachable only through approval, so it keeps that metadata.
    await client.query(`
      ALTER TABLE corrective_actions DROP CONSTRAINT corrective_actions_approval_check;
      ALTER TABLE corrective_actions ADD CONSTRAINT corrective_actions_approval_check
        CHECK (
          (status IN ('APPROVED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED')
            AND approved_at IS NOT NULL
            AND approved_by_user_id IS NOT NULL)
          OR
          (status IN ('PROPOSED', 'REJECTED')
            AND approved_at IS NULL
            AND approved_by_user_id IS NULL)
          OR
          status = 'CANCELLED'
        );
    `);

    // A verified action was completed first and RETAINS its completion
    // metadata; every other non-completed state still must not claim any.
    await client.query(`
      ALTER TABLE corrective_actions DROP CONSTRAINT corrective_actions_completion_check;
      ALTER TABLE corrective_actions ADD CONSTRAINT corrective_actions_completion_check
        CHECK (
          (status IN ('COMPLETED', 'VERIFIED')
            AND completed_at IS NOT NULL
            AND completed_by_user_id IS NOT NULL)
          OR
          (status NOT IN ('COMPLETED', 'VERIFIED')
            AND completed_at IS NULL
            AND completed_by_user_id IS NULL)
        );
    `);

    // Verification metadata exists exactly when the action is VERIFIED.
    await client.query(`
      ALTER TABLE corrective_actions
        ADD CONSTRAINT corrective_actions_verification_check
        CHECK (
          (status = 'VERIFIED'
            AND verified_at IS NOT NULL
            AND verified_by_user_id IS NOT NULL)
          OR
          (status <> 'VERIFIED'
            AND verified_at IS NULL
            AND verified_by_user_id IS NULL)
        )
    `);

    await client.query(`
      CREATE INDEX corrective_actions_verified_idx
        ON corrective_actions (status, verified_at)
        WHERE status = 'VERIFIED'
    `);
  },

  /**
   * A true inverse. Verified actions are returned to COMPLETED and their
   * verification records removed first, since neither can survive under the
   * restored constraints — the destructive-restore convention already used by
   * 0095, 0211, and 0213.
   */
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS corrective_actions_verified_idx;
      ALTER TABLE corrective_actions
        DROP CONSTRAINT IF EXISTS corrective_actions_verification_check;
    `);

    await client.query(`
      UPDATE corrective_actions
      SET status = 'COMPLETED', verified_at = NULL, verified_by_user_id = NULL
      WHERE status = 'VERIFIED'
    `);

    await client.query(`
      ALTER TABLE corrective_actions DROP CONSTRAINT corrective_actions_completion_check;
      ALTER TABLE corrective_actions ADD CONSTRAINT corrective_actions_completion_check
        CHECK (
          (status = 'COMPLETED'
            AND completed_at IS NOT NULL
            AND completed_by_user_id IS NOT NULL)
          OR
          (status <> 'COMPLETED'
            AND completed_at IS NULL
            AND completed_by_user_id IS NULL)
        );
    `);

    await client.query(`
      ALTER TABLE corrective_actions DROP CONSTRAINT corrective_actions_approval_check;
      ALTER TABLE corrective_actions ADD CONSTRAINT corrective_actions_approval_check
        CHECK (
          (status IN ('APPROVED', 'IN_PROGRESS', 'COMPLETED')
            AND approved_at IS NOT NULL
            AND approved_by_user_id IS NOT NULL)
          OR
          (status IN ('PROPOSED', 'REJECTED')
            AND approved_at IS NULL
            AND approved_by_user_id IS NULL)
          OR
          status = 'CANCELLED'
        );
    `);

    await client.query(`
      ALTER TABLE corrective_actions DROP CONSTRAINT corrective_actions_status_check;
      ALTER TABLE corrective_actions ADD CONSTRAINT corrective_actions_status_check
        CHECK (status IN (
          'PROPOSED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED',
          'REJECTED', 'CANCELLED'
        ));
    `);

    await client.query(`
      ALTER TABLE corrective_actions
        DROP COLUMN IF EXISTS verified_by_user_id,
        DROP COLUMN IF EXISTS verified_at
    `);

    await client.query(`
      DROP INDEX IF EXISTS corrective_action_pending_review_unique;
      DELETE FROM reviews WHERE target_type = 'CORRECTIVE_ACTION';
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (${sqlList(REVIEW_TARGET_UNION)})
      );
    `);
  },
};
