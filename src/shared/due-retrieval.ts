/**
 * CR-BE-STAB-03 PART 05 — bounded due-item retrieval.
 *
 * Due-window enumeration (e.g. due notification reminders / escalations)
 * must never pull an unbounded number of rows into a single worker pass:
 * every claimed item performs downstream work (template rendering, recipient
 * resolution, notification recording), so a large backlog could monopolize
 * one tick. Retrieval is therefore capped at a small batch; items left over
 * stay PENDING and are picked up by the next pass.
 *
 * Pure and dependency-free (no DB, no infrastructure) so it stays testable
 * without PostgreSQL.
 */

/** Small bounded batch size for one due-item retrieval pass. */
export const DUE_ITEM_RETRIEVAL_LIMIT = 100;

/**
 * Clamps a requested due-item batch size into
 * [1, DUE_ITEM_RETRIEVAL_LIMIT]. Non-finite input (NaN / ±Infinity) falls
 * back to the bounded default, so retrieval can never be made unbounded
 * through this seam.
 */
export function clampDueItemLimit(
  limit: number = DUE_ITEM_RETRIEVAL_LIMIT,
): number {
  if (!Number.isFinite(limit)) {
    return DUE_ITEM_RETRIEVAL_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), DUE_ITEM_RETRIEVAL_LIMIT);
}
