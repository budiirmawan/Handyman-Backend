import type { PoolClient } from 'pg';
import { REVIEW_TARGET_UNION } from './0213_restore_review_target_union';
import type { Migration } from './types';

/**
 * CR-BE-STAB-01 PART 01 — restore `CORRECTIVE_ACTION` to `reviews.review_target`.
 *
 * REGRESSION BEING FIXED
 * ----------------------
 * `0222_add_corrective_action_verification` (BE-21J) added `'CORRECTIVE_ACTION'`
 * to the `reviews.review_target` CHECK constraint, following the forward rule
 * stated in `0213` (add to the union, never restate a subset). A later,
 * unrelated migration — `0232_add_document_approval_target` (BE-22I) — re-declared
 * the constraint from scratch and silently dropped `'CORRECTIVE_ACTION'`.
 *
 * Because `migrateUp` applies the full ordered migration list, the FINAL
 * effective constraint on any database is `0232`'s, which rejects the value
 * the corrective-action verification module writes (`target_type =
 * 'CORRECTIVE_ACTION'`). Every open of a verification then fails with a CHECK
 * violation (SQLSTATE 23514), the action can never reach `VERIFIED`, and —
 * since incident closure requires every required action to be `VERIFIED` —
 * any Incident with a required corrective action becomes permanently
 * uncloseable.
 *
 * THE FIX (ADDITIVE)
 * ------------------
 * Historical migrations are NOT modified. This additive migration re-declares
 * the constraint ONCE as the current full union:
 *
 *   the canonical historical union exported by `0213` (FORM_INSTANCE,
 *   CHECKLIST_EXECUTION, WORK_ORDER, FINDING, VENDOR_WORK,
 *   UTILITY_ABNORMAL_CONSUMPTION, PERMIT_APPLICATION) — every value still
 *   valid today,
 *
 *   PLUS the DOCUMENT targets introduced by `0232` and still in effect,
 *
 *   PLUS `'CORRECTIVE_ACTION'` (restoring what `0232` dropped).
 *
 * The list is DERIVED from the canonical `REVIEW_TARGET_UNION` and the still-
 * active `0232` additions rather than hard-coded as a reduced subset, so no
 * value introduced after `0222` is lost. No target is removed. `down` follows
 * the destructive-restore convention used by `0095`, `0211`, `0213`, and
 * `0222`: `CORRECTIVE_ACTION` review rows are removed before the constraint
 * is restored to the pre-fix (`0232`) state.
 */

/** Still-active targets introduced by 0232 (post-0213). */
const POST_UNION_DOCUMENT_TARGETS = ['DOCUMENT', 'DOCUMENT_VERSION'] as const;

/**
 * The complete current allowed set: the canonical historical union, the
 * `0232` DOCUMENT targets, and the restored `CORRECTIVE_ACTION`.
 */
const REVIEW_TARGETS_WITH_CORRECTIVE_ACTION = [
  ...REVIEW_TARGET_UNION,
  ...POST_UNION_DOCUMENT_TARGETS,
  'CORRECTIVE_ACTION',
] as const;

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

export const migration0286AddCorrectiveActionReviewTarget: Migration = {
  id: '0286_add_corrective_action_review_target',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (${sqlList(REVIEW_TARGETS_WITH_CORRECTIVE_ACTION)})
      );
    `);
  },

  /**
   * A true inverse. `CORRECTIVE_ACTION` review rows cannot survive under the
   * restored (`0232`) constraint, so they are removed first — the
   * destructive-restore convention already used by 0095, 0211, 0213, and 0222.
   */
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM reviews WHERE target_type = 'CORRECTIVE_ACTION';
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (
          'FORM_INSTANCE',
          'CHECKLIST_EXECUTION',
          'WORK_ORDER',
          'FINDING',
          'VENDOR_WORK',
          'UTILITY_ABNORMAL_CONSUMPTION',
          'PERMIT_APPLICATION',
          'DOCUMENT',
          'DOCUMENT_VERSION'
        )
      );
    `);
  },
};
