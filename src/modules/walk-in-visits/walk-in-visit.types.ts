/**
 * BE-13D — Walk-In / Guest Book domain types.
 *
 * A Walk-In visit is the front-desk guest-book entry for a visitor who
 * arrives WITHOUT a prior invitation. The entry references the shared
 * BE-13A visitor identity — either an existing matched visitor
 * (`visitorId`) or a new identity registered inline through the BE-13A
 * service (`newVisitor`). It never creates a second visitor master.
 *
 * Host context is OPTIONAL ("where available") — an unannounced guest
 * may have no resolvable host at arrival time. When supplied, host
 * references are validated like BE-13B/C.
 *
 * Duplicate handling: one open (REGISTERED) entry per
 * (building, visitor); cancelled entries never block re-registration.
 *
 * Lifecycle (minimal, backend-authoritative):
 *   REGISTERED → CANCELLED
 * CANCELLED is terminal. Check-In consumption arrives in a later PART.
 */

import type {
  VisitorIdentityType,
} from '../visitors';

export const WALK_IN_VISIT_STATUSES = ['REGISTERED', 'CANCELLED'] as const;

export type WalkInVisitStatus = (typeof WALK_IN_VISIT_STATUSES)[number];

export function isWalkInVisitStatus(
  value: unknown,
): value is WalkInVisitStatus {
  return (
    typeof value === 'string' &&
    (WALK_IN_VISIT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type WalkInVisitRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  purpose: string;
  arrivedAt: Date;
  frontDeskNotes: string | null;
  status: WalkInVisitStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWalkInVisit = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  purpose: string;
  arrivedAt: string;
  frontDeskNotes: string | null;
  status: WalkInVisitStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Inline new-visitor registration payload. Delegated verbatim to the
 * BE-13A visitor service (same validation, duplicate handling and
 * Client scoping) — the walk-in module never writes the visitor master
 * directly.
 */
export type WalkInNewVisitorInput = {
  fullName: string;
  identityType?: VisitorIdentityType;
  identityNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  organizationName?: string | null;
  notes?: string | null;
};

/**
 * Create input: exactly ONE of `visitorId` (reuse an existing matched
 * identity) or `newVisitor` (register a new identity via BE-13A).
 */
export type CreateWalkInVisitInput = {
  buildingId: string;
  visitorId?: string;
  newVisitor?: WalkInNewVisitorInput;
  hostUserId?: string | null;
  hostWorkforceId?: string | null;
  hostName?: string | null;
  purpose: string;
  /** ISO timestamp; defaults to now. Must not be in the future. */
  arrivedAt?: string;
  frontDeskNotes?: string | null;
  createdByUserId: string;
};

export type UpdateWalkInVisitInput = {
  hostUserId?: string | null;
  hostWorkforceId?: string | null;
  hostName?: string | null;
  purpose?: string;
  arrivedAt?: string;
  frontDeskNotes?: string | null;
};

export type WalkInVisitListFilters = {
  buildingId?: string;
  visitorId?: string;
  hostUserId?: string;
  status?: WalkInVisitStatus;
  /** Inclusive ISO lower bound on the arrival. */
  arrivedFrom?: string;
  /** Inclusive ISO upper bound on the arrival. */
  arrivedTo?: string;
};
