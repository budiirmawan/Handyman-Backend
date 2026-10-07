/**
 * BE-13F — Host / Tenant Confirmation domain types.
 *
 * Backend-authoritative host confirmation over an existing BE-13 visit
 * context — an Expected Visitor (BE-13C) or a Walk-In / Guest Book
 * entry (BE-13D). Exactly one visit reference per confirmation, one
 * confirmation per visit.
 *
 * Tenant boundary: no Tenant Management domain exists — the record
 * carries the smallest safe host/tenant reference already used by
 * BE-13B/C/D (host User, host Workforce, free-form host/tenant name),
 * defaulted from the visit and overridable with validation.
 *
 * Lifecycle:
 *   PENDING → CONFIRMED | REJECTED  (single, terminal decision)
 * A REJECTED visit can never proceed as confirmed.
 */

export const HOST_CONFIRMATION_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'REJECTED',
] as const;

export type HostConfirmationStatus =
  (typeof HOST_CONFIRMATION_STATUSES)[number];

export function isHostConfirmationStatus(
  value: unknown,
): value is HostConfirmationStatus {
  return (
    typeof value === 'string' &&
    (HOST_CONFIRMATION_STATUSES as readonly string[]).includes(value)
  );
}

/** The two visit context kinds a confirmation can reference. */
export type HostConfirmationVisitType = 'EXPECTED_VISITOR' | 'WALK_IN_VISIT';

/** Full database record. */
export type HostConfirmationRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  status: HostConfirmationStatus;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
  rejectionReason: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicHostConfirmation = {
  id: string;
  clientId: string;
  buildingId: string;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  status: HostConfirmationStatus;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  rejectionReason: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Create (request) input: exactly ONE of `expectedVisitorId` /
 * `walkInVisitId`. Host references default from the visit record when
 * not supplied.
 */
export type CreateHostConfirmationInput = {
  expectedVisitorId?: string;
  walkInVisitId?: string;
  hostUserId?: string | null;
  hostWorkforceId?: string | null;
  hostName?: string | null;
  notes?: string | null;
  createdByUserId: string;
};

export type ConfirmHostConfirmationInput = {
  notes?: string | null;
};

export type RejectHostConfirmationInput = {
  rejectionReason: string;
  notes?: string | null;
};

export type HostConfirmationListFilters = {
  buildingId?: string;
  expectedVisitorId?: string;
  walkInVisitId?: string;
  hostUserId?: string;
  status?: HostConfirmationStatus;
};
