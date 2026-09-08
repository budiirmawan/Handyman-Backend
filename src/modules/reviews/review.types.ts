/** BE-07 shared Review & Verification decisions. */
export const REVIEW_DECISIONS = [
  'APPROVED',
  'REJECTED',
  'REWORK_REQUIRED',
] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return typeof value === 'string' &&
    (REVIEW_DECISIONS as readonly string[]).includes(value);
}
