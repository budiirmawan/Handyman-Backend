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
