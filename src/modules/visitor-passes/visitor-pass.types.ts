/**
 * BE-13I — Visitor Pass domain types.
 *
 * A pass references one BE-13G/H visit lifecycle (`visit_check_ins`).
 * It is an administrative visitor credential only; physical access
 * control hardware and integrations are outside this boundary.
 *
 * Lifecycle:
 *   ACTIVE → RETURNED | CANCELLED
 */

export const VISITOR_PASS_STATUSES = [
  'ACTIVE',
  'RETURNED',
  'CANCELLED',
] as const;

export type VisitorPassStatus = (typeof VISITOR_PASS_STATUSES)[number];

export function isVisitorPassStatus(
  value: unknown,
): value is VisitorPassStatus {
  return (
    typeof value === 'string' &&
    (VISITOR_PASS_STATUSES as readonly string[]).includes(value)
  );
}

export type VisitorPassRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  visitCheckInId: string;
  passCode: string;
  issuedAt: Date;
  issuedByUserId: string;
  status: VisitorPassStatus;
  returnedAt: Date | null;
  returnedByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicVisitorPass = {
  id: string;
  clientId: string;
  buildingId: string;
  visitCheckInId: string;
  passCode: string;
  issuedAt: string;
  issuedByUserId: string;
  status: VisitorPassStatus;
  returnedAt: string | null;
  returnedByUserId: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IssueVisitorPassInput = {
  buildingId: string;
  visitCheckInId: string;
  passCode: string;
  /** ISO timestamp; defaults to now. */
  issuedAt?: string;
  issuedByUserId: string;
};

export type ReturnVisitorPassInput = {
  /** ISO timestamp; defaults to now. */
  returnedAt?: string;
  returnedByUserId: string;
};

export type VisitorPassListFilters = {
  buildingId?: string;
  status?: VisitorPassStatus;
  visitCheckInId?: string;
};
