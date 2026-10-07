/**
 * BE-11G — Supervisor Inspection domain types.
 *
 * Links an inspected Housekeeping execution (Daily Cleaning task, Toilet
 * Inspection execution, or Public Area Inspection execution) to a supervisor
 * verification decision, reusing the shared BE-07 Review / Verification engine.
 */

export const SUPERVISOR_INSPECTION_TARGET_TYPES = [
  'DAILY_CLEANING',
  'TOILET_INSPECTION',
  'PUBLIC_AREA_INSPECTION',
] as const;
export type SupervisorInspectionTargetType =
  (typeof SUPERVISOR_INSPECTION_TARGET_TYPES)[number];

export const SUPERVISOR_INSPECTION_STATUSES = [
  'PENDING',
  'COMPLETED',
] as const;
export type SupervisorInspectionStatus =
  (typeof SUPERVISOR_INSPECTION_STATUSES)[number];

export const SUPERVISOR_INSPECTION_DECISIONS = [
  'APPROVED',
  'REJECTED',
  'REWORK_REQUIRED',
] as const;
export type SupervisorInspectionDecision =
  (typeof SUPERVISOR_INSPECTION_DECISIONS)[number];

export function isSupervisorInspectionTargetType(
  value: unknown,
): value is SupervisorInspectionTargetType {
  return (
    typeof value === 'string' &&
    (SUPERVISOR_INSPECTION_TARGET_TYPES as readonly string[]).includes(value)
  );
}

export function isSupervisorInspectionStatus(
  value: unknown,
): value is SupervisorInspectionStatus {
  return (
    typeof value === 'string' &&
    (SUPERVISOR_INSPECTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isSupervisorInspectionDecision(
  value: unknown,
): value is SupervisorInspectionDecision {
  return (
    typeof value === 'string' &&
    (SUPERVISOR_INSPECTION_DECISIONS as readonly string[]).includes(value)
  );
}

/**
 * Operational states of an inspected target that may be reviewed.
 *
 * Single source of truth for the reviewability rule: `resolveTarget` refuses
 * to open an inspection outside these states, and the target-scoped mobile
 * context only offers `CREATE_INSPECTION` while the state still allows it.
 */
export const SUPERVISOR_INSPECTION_REVIEWABLE_TARGET_STATUSES = [
  'IN_PROGRESS',
  'COMPLETED',
] as const;

export function isSupervisorInspectionReviewableTargetStatus(
  value: string,
): boolean {
  return (
    SUPERVISOR_INSPECTION_REVIEWABLE_TARGET_STATUSES as readonly string[]
  ).includes(value);
}

/**
 * CR-BE-RN14-CLEANING-SUPERVISOR-MOBILE-01 — backend-resolved command
 * authority for the supervisor inspection surface.
 *
 * These tokens are computed from live state × permission × Building access on
 * every read. Mobile renders them; it never derives them locally.
 */
export const SUPERVISOR_INSPECTION_MOBILE_ACTIONS = [
  'CREATE_INSPECTION',
  'SUBMIT_DECISION',
] as const;
export type SupervisorInspectionMobileAction =
  (typeof SUPERVISOR_INSPECTION_MOBILE_ACTIONS)[number];

export type SupervisorInspectionRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  targetType: SupervisorInspectionTargetType;
  targetId: string;
  reviewId: string | null;
  supervisorUserId: string;
  decision: SupervisorInspectionDecision | null;
  status: SupervisorInspectionStatus;
  notes: string | null;
  inspectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicSupervisorInspection = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  targetType: SupervisorInspectionTargetType;
  targetId: string;
  reviewId: string | null;
  supervisorUserId: string;
  decision: SupervisorInspectionDecision | null;
  status: SupervisorInspectionStatus;
  notes: string | null;
  inspectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  cleaningArea?: {
    id: string;
    code: string;
    name: string;
    cleaningAreaType: string;
    status: string;
  };
  targetSummary?: {
    status: string;
    description: string;
  } | null;
};

export type CreateSupervisorInspectionInput = {
  targetType: SupervisorInspectionTargetType;
  targetId: string;
  notes?: string | null;
  supervisorUserId: string;
};

export type SubmitSupervisorDecisionInput = {
  decision: SupervisorInspectionDecision;
  notes?: string | null;
};

export type SupervisorInspectionFilter = {
  buildingId?: string;
  cleaningAreaId?: string;
  targetType?: SupervisorInspectionTargetType;
  status?: SupervisorInspectionStatus;
};

/**
 * CR-BE-RN14-CLEANING-SUPERVISOR-MOBILE-01 — target-scoped discovery of the
 * DAILY_CLEANING supervisor inspection.
 *
 * `inspection` is the current PENDING inspection of the Daily Cleaning task
 * (or `null` when none is open). `availableActions` is the authoritative
 * command list the caller may issue next; it is never derived on the client.
 */
export type DailyCleaningSupervisorInspectionContext = {
  inspection: PublicSupervisorInspection | null;
  availableActions: SupervisorInspectionMobileAction[];
};
