/**
 * CR-HM-05 PART 02 — Handyman Unit Access Readiness types (FROZEN
 * F5/F6/F7/F8).
 *
 * AUTHORIZATION/READINESS ONLY: whether access to the request's
 * authoritative building/unit-space is operationally readied for later
 * service execution. This is NOT arrival verification, NOT physical
 * check-in, NOT QR/geofence/visitor/attendance/session proof (F6;
 * CR-HM-07 owns physical arrival exclusively).
 */

/**
 * Smallest readiness vocabulary (F5/F6-derived, FROZEN): ACTIVE = the
 * current authorization/readiness fact; INACTIVE = superseded history
 * (never hard-deleted). Presence/verification states (ARRIVED,
 * CHECKED_IN, VERIFIED, ON_SITE, WORK_STARTED) are FROZEN-forbidden and
 * can never be added by this vocabulary.
 */
export const HANDYMAN_UNIT_ACCESS_READINESS_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HandymanUnitAccessReadinessStatus =
  (typeof HANDYMAN_UNIT_ACCESS_READINESS_STATUSES)[number];

export function isHandymanUnitAccessReadinessStatus(
  value: unknown,
): value is HandymanUnitAccessReadinessStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_UNIT_ACCESS_READINESS_STATUSES as readonly string[])
      .includes(value)
  );
}

export type HandymanUnitAccessReadinessRecord = {
  id: string;
  /** Tenant-isolation root, server-derived from the request chain. */
  clientId: string;
  /** Authority: the existing Handyman Service Request (CR-HM-02). */
  handymanRequestId: string;
  /** Authoritative location chain — derived, never caller input. */
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  /** The request's authoritative unit/space. */
  spaceId: string;
  accessWindowStart: Date;
  accessWindowEnd: Date;
  authorizationNote: string;
  status: HandymanUnitAccessReadinessStatus;
  /** PART 04 linkage: the ACTIVE row this one replaced (null = chain head). */
  supersedesReadinessId: string | null;
  authorizedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Caller input — request reference + access window + authorization note
 * ONLY. clientId, all location references, the authorizer, and any
 * presence-proof fields can never be input (F5/F7).
 */
export type CreateHandymanUnitAccessReadinessInput = {
  handymanRequestId: string;
  accessWindowStart: string;
  accessWindowEnd: string;
  authorizationNote: string;
};

/** Window/note replacement for a supersede (material change). */
export type SupersedeHandymanUnitAccessReadinessInput = {
  accessWindowStart: string;
  accessWindowEnd: string;
  authorizationNote: string;
};

export type NewHandymanUnitAccessReadinessRecord = Omit<
  HandymanUnitAccessReadinessRecord,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;

/** Safe public representation (timestamps ISO). */
export type PublicHandymanUnitAccessReadiness = Omit<
  HandymanUnitAccessReadinessRecord,
  'accessWindowStart' | 'accessWindowEnd' | 'createdAt' | 'updatedAt'
> & {
  accessWindowStart: string;
  accessWindowEnd: string;
  createdAt: string;
  updatedAt: string;
};
