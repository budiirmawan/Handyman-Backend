/**
 * BE-13G — Check-In domain types.
 *
 * The backend-authoritative check-in over an existing BE-13 visit
 * context (Expected Visitor / Walk-In). The visitor identity travels
 * through the visit reference — never duplicated.
 *
 * Confirmation gate: when a BE-13F host confirmation exists for the
 * visit it must be CONFIRMED (PENDING / REJECTED block the check-in).
 * Visits without any confirmation record may check in.
 *
 * Lifecycle (minimal, backend-authoritative — ONE controlled visit
 * lifecycle for Check-In and Check-Out):
 *   CHECKED_IN → CHECKED_OUT (BE-13H — closes the active visit)
 *   CHECKED_IN → CANCELLED   (mistake reversal only)
 * At most one active check-in per visit; a cancelled check-in frees
 * the visit for a fresh one. Check-Out preserves the original
 * check-in history on the same row (checked_in_* untouched) and is
 * terminal — a completed visit never re-activates.
 */

export const VISIT_CHECK_IN_STATUSES = [
  'CHECKED_IN',
  'CHECKED_OUT',
  'CANCELLED',
] as const;

export type VisitCheckInStatus = (typeof VISIT_CHECK_IN_STATUSES)[number];

export function isVisitCheckInStatus(
  value: unknown,
): value is VisitCheckInStatus {
  return (
    typeof value === 'string' &&
    (VISIT_CHECK_IN_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VisitCheckInRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  checkedInAt: Date;
  checkedInByUserId: string;
  entryNotes: string | null;
  checkedOutAt: Date | null;
  checkedOutByUserId: string | null;
  exitNotes: string | null;
  status: VisitCheckInStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVisitCheckIn = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  checkedInAt: string;
  checkedInByUserId: string;
  entryNotes: string | null;
  checkedOutAt: string | null;
  checkedOutByUserId: string | null;
  exitNotes: string | null;
  status: VisitCheckInStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * Create input: exactly ONE of `expectedVisitorId` / `walkInVisitId`.
 * Building / Client / visitor identity all derive from the visit.
 */
export type CreateVisitCheckInInput = {
  expectedVisitorId?: string;
  walkInVisitId?: string;
  /** ISO timestamp; defaults to now. Must not be in the future. */
  checkedInAt?: string;
  entryNotes?: string | null;
  checkedInByUserId: string;
};

/** BE-13H — Check-Out input over an active check-in row. */
export type CheckOutVisitInput = {
  /** ISO timestamp; defaults to now. Must not be in the future and
   *  must not precede the original check-in. */
  checkedOutAt?: string;
  exitNotes?: string | null;
  checkedOutByUserId: string;
};

export type VisitCheckInListFilters = {
  buildingId?: string;
  visitorId?: string;
  expectedVisitorId?: string;
  walkInVisitId?: string;
  status?: VisitCheckInStatus;
  /** Inclusive ISO lower bound on checked_in_at. */
  checkedInFrom?: string;
  /** Inclusive ISO upper bound on checked_in_at. */
  checkedInTo?: string;
  /** Inclusive ISO lower bound on checked_out_at. */
  checkedOutFrom?: string;
  /** Inclusive ISO upper bound on checked_out_at. */
  checkedOutTo?: string;
};
