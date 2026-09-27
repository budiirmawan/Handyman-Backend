/**
 * CR-HM-05 PART 01 — Handyman Scheduling Readiness types (FROZEN
 * F1/F2/F7/F8/F9/F10 containment).
 *
 * READINESS ONLY: a preference fact on an existing Handyman Service
 * Request for LATER binding to the CR-HM-06 execution scope. It is NOT
 * an execution schedule — no job, work order, executionScopeId,
 * targetId, provider/crew binding, recurrence execution, attendance,
 * work session or arrival verification exists here.
 */

/**
 * Smallest readiness vocabulary (F2-derived, FROZEN): ACTIVE = the
 * current readiness fact for the request; INACTIVE = superseded history
 * (never hard-deleted). Execution states (SCHEDULED / DISPATCHED /
 * ASSIGNED / IN_PROGRESS) are FROZEN-forbidden and can never be added
 * by this vocabulary.
 */
export const HANDYMAN_SCHEDULING_READINESS_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HandymanSchedulingReadinessStatus =
  (typeof HANDYMAN_SCHEDULING_READINESS_STATUSES)[number];

export function isHandymanSchedulingReadinessStatus(
  value: unknown,
): value is HandymanSchedulingReadinessStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SCHEDULING_READINESS_STATUSES as readonly string[])
      .includes(value)
  );
}

export type HandymanSchedulingReadinessRecord = {
  id: string;
  /** Tenant-isolation root, server-derived from the request chain. */
  clientId: string;
  /** Authority: the existing Handyman Service Request (CR-HM-02). */
  handymanRequestId: string;
  /** Server-derived from buildings.timezone (location authority). */
  timezone: string;
  preferredWindowStart: Date;
  preferredWindowEnd: Date;
  status: HandymanSchedulingReadinessStatus;
  /** PART 04 linkage: the ACTIVE row this one replaced (null = chain head). */
  supersedesReadinessId: string | null;
  /** PART 04: bounded optional scheduling-owned reason (no taxonomy). */
  changeReason: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Caller input — request reference + preferred window ONLY. clientId,
 * buildingId, timezone, execution targets, provider and crew can never
 * be input (F7/F9).
 */
export type CreateHandymanSchedulingReadinessInput = {
  handymanRequestId: string;
  preferredWindowStart: string;
  preferredWindowEnd: string;
  /** PART 04 optional bounded reason (scheduling-owned, no taxonomy). */
  changeReason?: string;
};

/** Window replacement for a supersede (material readiness change). */
export type SupersedeHandymanSchedulingReadinessInput = {
  preferredWindowStart: string;
  preferredWindowEnd: string;
  /** PART 04 optional bounded reason (scheduling-owned, no taxonomy). */
  changeReason?: string;
};

export type NewHandymanSchedulingReadinessRecord = Omit<
  HandymanSchedulingReadinessRecord,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;

/** Safe public representation (timestamps ISO). */
export type PublicHandymanSchedulingReadiness = Omit<
  HandymanSchedulingReadinessRecord,
  'preferredWindowStart' | 'preferredWindowEnd' | 'createdAt' | 'updatedAt'
> & {
  preferredWindowStart: string;
  preferredWindowEnd: string;
  createdAt: string;
  updatedAt: string;
};
