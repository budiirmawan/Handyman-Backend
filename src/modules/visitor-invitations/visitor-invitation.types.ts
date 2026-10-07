/**
 * BE-13B — Visitor Invitation domain types.
 *
 * A Visitor Invitation is a visit-planning record: a known Visitor
 * identity (BE-13A `visitors` master) is invited to a Building for an
 * expected date/time window by a host. It never duplicates visitor
 * personal data and never carries the operational Visit lifecycle
 * (Check-In / Pass / Check-Out arrive in later BE-13 PARTs).
 *
 * Host boundary: no authoritative Tenant domain exists yet, so the
 * invitation carries the smallest safe host reference — an optional
 * internal User (`hostUserId`), an optional Workforce profile
 * (`hostWorkforceId`) and/or a free-form `hostName`. At least one host
 * reference is required.
 *
 * Lifecycle (minimal, backend-authoritative):
 *   PENDING → CANCELLED
 * CANCELLED is terminal; a cancelled invitation is never re-activated.
 */

export const VISITOR_INVITATION_STATUSES = ['PENDING', 'CANCELLED'] as const;

export type VisitorInvitationStatus =
  (typeof VISITOR_INVITATION_STATUSES)[number];

export function isVisitorInvitationStatus(
  value: unknown,
): value is VisitorInvitationStatus {
  return (
    typeof value === 'string' &&
    (VISITOR_INVITATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VisitorInvitationRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  expectedArrivalAt: Date;
  expectedDepartureAt: Date | null;
  purpose: string;
  notes: string | null;
  status: VisitorInvitationStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVisitorInvitation = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  expectedArrivalAt: string;
  expectedDepartureAt: string | null;
  purpose: string;
  notes: string | null;
  status: VisitorInvitationStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateVisitorInvitationInput = {
  buildingId: string;
  visitorId: string;
  hostUserId?: string | null;
  hostWorkforceId?: string | null;
  hostName?: string | null;
  /** ISO timestamp. */
  expectedArrivalAt: string;
  /** ISO timestamp; must be after `expectedArrivalAt`. */
  expectedDepartureAt?: string | null;
  purpose: string;
  notes?: string | null;
  createdByUserId: string;
};

export type UpdateVisitorInvitationInput = {
  hostUserId?: string | null;
  hostWorkforceId?: string | null;
  hostName?: string | null;
  expectedArrivalAt?: string;
  expectedDepartureAt?: string | null;
  purpose?: string;
  notes?: string | null;
};

export type VisitorInvitationListFilters = {
  buildingId?: string;
  visitorId?: string;
  hostUserId?: string;
  status?: VisitorInvitationStatus;
  /** Inclusive ISO lower bound on the expected arrival. */
  expectedFrom?: string;
  /** Inclusive ISO upper bound on the expected arrival. */
  expectedTo?: string;
};
