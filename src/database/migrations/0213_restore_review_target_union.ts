import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-21 — restore the FULL union of historical `reviews.review_target` values.
 *
 * REGRESSION BEING FIXED
 * ----------------------
 * `reviews.review_target` has been re-declared several times, and each
 * re-declaration hard-coded the value list it believed to be current instead
 * of adding to the existing one:
 *
 *   0074 create_reviews                 FORM_INSTANCE, CHECKLIST_EXECUTION
 *   0089 work_order_verification      + WORK_ORDER
 *   0095 finding_reviews              + FINDING                       ← added
 *   0163 vendor_work_verification     + VENDOR_WORK, but dropped FINDING
 *   0193 utility_verification         + UTILITY_ABNORMAL_CONSUMPTION  (still no FINDING)
 *   0207 permit_approval_bindings     + PERMIT_APPLICATION            (still no FINDING)
 *
 * From 0163 onward `'FINDING'` silently disappeared from the CHECK, so on a
 * freshly migrated database every BE-09 verification insert
 * (`findingReviewRepository.createPending`, which writes
 * `target_type = 'FINDING'`) violates `review_target`. That makes the BE-09F
 * review, BE-09G rework, and BE-09H closure paths unreachable end-to-end.
 *
 * THE FIX
 * -------
 * Historical migrations are NOT modified — they remain the immutable record of
 * what each Wave did. This additive migration re-declares the constraint once
 * as the UNION of every target the repository history has ever supported, so
 * no previously valid value is removed or renamed.
 *
 * FORWARD RULE
 * ------------
 * Any future migration touching `review_target` must ADD to this union and
 * never restate a subset. BE-21 targets are deliberately NOT added here: a
 * review target is introduced only by the PART whose implementation actually
 * writes it (BE-21J Verification), not by the foundation.
 *
 * The partial unique indexes created alongside those constraints
 * (`finding_pending_review_unique`, `utility_abnormal_pending_review_unique`,
 * …) were never dropped by the offending migrations, so they survive intact
 * and are deliberately left untouched here.
 */

/** Every `reviews.target_type` value supported by repository history. */
export const REVIEW_TARGET_UNION = [
  'FORM_INSTANCE',
  'CHECKLIST_EXECUTION',
  'WORK_ORDER',
  'FINDING',
  'VENDOR_WORK',
  'UTILITY_ABNORMAL_CONSUMPTION',
  'PERMIT_APPLICATION',
] as const;

/** The value list as it stood after 0207 — i.e. missing FINDING. */
const PRE_FIX_TARGETS = REVIEW_TARGET_UNION.filter(
  (target) => target !== 'FINDING',
);

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

export const migration0213RestoreReviewTargetUnion: Migration = {
  id: '0213_restore_review_target_union',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (${sqlList(REVIEW_TARGET_UNION)})
      );
    `);
  },

  /**
   * Restores the (defective) post-0207 constraint so the migration is a true
   * inverse. Reverting re-introduces the regression by design — FINDING
   * reviews must be removed first, mirroring the destructive-restore
   * convention already used by 0095 and 0211.
   */
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DELETE FROM reviews WHERE target_type = 'FINDING';
      ALTER TABLE reviews DROP CONSTRAINT review_target;
      ALTER TABLE reviews ADD CONSTRAINT review_target CHECK (
        target_type IN (${sqlList(PRE_FIX_TARGETS)})
      );
    `);
  },
};
