/**
 * CR-HM-05 PART 03 — Handyman Permit Readiness types (FROZEN F4/F5/F7/F8).
 *
 * AUTHORIZATION/READINESS ONLY for tenant/unit service access. This is
 * NOT FM Permit-to-Work and NOT execution authorization: validity proves
 * neither worker arrival, on-site identity verification, work start,
 * nor completed safety inspection (F4/F6/F10; CR-HM-07 owns physical
 * arrival proof).
 */

/**
 * Bounded Handyman permit vocabulary (F4-derived, FROZEN): the actual
 * tenant/unit service-access needs of a Handyman request reduce to the
 * authoritative unit space itself and building-managed common areas
 * adjacent to it. The FM Permit-to-Work free-form type list is NEVER
 * copied; growing this vocabulary requires explicit governance.
 */
export const HANDYMAN_PERMIT_TYPES = [
  'UNIT',
  'BUILDING_COMMON_AREA',
] as const;
export type HandymanPermitType = (typeof HANDYMAN_PERMIT_TYPES)[number];

export function isHandymanPermitType(
  value: unknown,
): value is HandymanPermitType {
  return (
    typeof value === 'string' &&
    (HANDYMAN_PERMIT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Smallest permit-readiness vocabulary (FROZEN): ACTIVE = the current
 * authorization/readiness fact; INACTIVE = superseded history (never
 * hard-deleted). Execution states (IN_PROGRESS / WORKING / COMPLETED /
 * CLOSED) and the FM PTW lifecycle are FROZEN-forbidden.
 */
export const HANDYMAN_PERMIT_READINESS_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HandymanPermitReadinessStatus =
  (typeof HANDYMAN_PERMIT_READINESS_STATUSES)[number];

export function isHandymanPermitReadinessStatus(
  value: unknown,
): value is HandymanPermitReadinessStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_PERMIT_READINESS_STATUSES as readonly string[])
      .includes(value)
  );
}

export type HandymanPermitReadinessRecord = {
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
  spaceId: string;
  permitType: HandymanPermitType;
  validFrom: Date;
  validUntil: Date;
  authorizationNote: string;
  status: HandymanPermitReadinessStatus;
  /** PART 04 linkage: the ACTIVE row this one replaced (null = chain head). */
  supersedesReadinessId: string | null;
  authorizedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Caller input — request reference + bounded permit type + validity +
 * note ONLY. clientId, all location references, the authorizer, FM
 * permit/work-order references, provider/crew and any proof-of-presence
 * fields can never be input (F4/F5/F7).
 */
export type CreateHandymanPermitReadinessInput = {
  handymanRequestId: string;
  permitType: string;
  validFrom: string;
  validUntil: string;
  authorizationNote: string;
};

/** Type/validity/note replacement for a supersede (material change). */
export type SupersedeHandymanPermitReadinessInput = {
  permitType: string;
  validFrom: string;
  validUntil: string;
  authorizationNote: string;
};

export type NewHandymanPermitReadinessRecord = Omit<
  HandymanPermitReadinessRecord,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;

/** Safe public representation (timestamps ISO). */
export type PublicHandymanPermitReadiness = Omit<
  HandymanPermitReadinessRecord,
  'validFrom' | 'validUntil' | 'createdAt' | 'updatedAt'
> & {
  validFrom: string;
  validUntil: string;
  createdAt: string;
  updatedAt: string;
};
