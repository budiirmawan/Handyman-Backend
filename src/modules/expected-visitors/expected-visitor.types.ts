/**
 * BE-13C — Expected Visitor domain types.
 *
 * The front-desk "who is expected" operational record. References the
 * shared BE-13A visitor identity (never duplicates it) and, where the
 * visit was planned ahead, the BE-13B visitor invitation. An expected
 * visitor may also exist WITHOUT an invitation (host phones the front
 * desk directly) — `visitorInvitationId` is nullable.
 *
 * When created from an invitation, Building / Visitor / host / window
 * default from the invitation and must remain consistent (same
 * Building, same Visitor). At most one non-cancelled expected visitor
 * exists per invitation.
 *
 * Lifecycle (minimal, backend-authoritative):
 *   EXPECTED → CANCELLED
 * CANCELLED is terminal. Check-In consumption arrives in a later PART.
 */

export const EXPECTED_VISITOR_STATUSES = ['EXPECTED', 'CANCELLED'] as const;

export type ExpectedVisitorStatus = (typeof EXPECTED_VISITOR_STATUSES)[number];

export function isExpectedVisitorStatus(
  value: unknown,
): value is ExpectedVisitorStatus {
  return (
    typeof value === 'string' &&
    (EXPECTED_VISITOR_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type ExpectedVisitorRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  visitorInvitationId: string | null;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  expectedArrivalAt: Date;
  expectedDepartureAt: Date | null;
  purpose: string;
  notes: string | null;
  status: ExpectedVisitorStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicExpectedVisitor = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  visitorInvitationId: string | null;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  expectedArrivalAt: string;
  expectedDepartureAt: string | null;
  purpose: string;
  notes: string | null;
  status: ExpectedVisitorStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Create input. When `visitorInvitationId` is supplied, `buildingId`,
 * `visitorId`, host references, window and purpose default from the
 * invitation; explicitly supplied values must stay consistent with it
 * (same Building, same Visitor).
 */
export type CreateExpectedVisitorInput = {
  buildingId?: string;
  visitorId?: string;
  visitorInvitationId?: string | null;
  hostUserId?: string | null;
  hostWorkforceId?: string | null;
  hostName?: string | null;
  /** ISO timestamp. */
  expectedArrivalAt?: string;
  /** ISO timestamp; must be after `expectedArrivalAt`. */
  expectedDepartureAt?: string | null;
  purpose?: string;
  notes?: string | null;
  createdByUserId: string;
};

export type UpdateExpectedVisitorInput = {
  hostUserId?: string | null;
  hostWorkforceId?: string | null;
  hostName?: string | null;
  expectedArrivalAt?: string;
  expectedDepartureAt?: string | null;
  purpose?: string;
  notes?: string | null;
};

export type ExpectedVisitorListFilters = {
  buildingId?: string;
  visitorId?: string;
  visitorInvitationId?: string;
  hostUserId?: string;
  status?: ExpectedVisitorStatus;
  /** Inclusive ISO lower bound on the expected arrival. */
  expectedFrom?: string;
  /** Inclusive ISO upper bound on the expected arrival. */
  expectedTo?: string;
};
