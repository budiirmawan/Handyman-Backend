import type { PermitApplicationStatus } from '../permit-applications/permit-application.types';

export const PERMIT_SAFETY_READINESS_STATUSES = [
  'PENDING',
  'READY',
  'NOT_READY',
  'NOT_REQUIRED',
] as const;

export type PermitSafetyReadinessStatus =
  (typeof PERMIT_SAFETY_READINESS_STATUSES)[number];

export function isPermitSafetyReadinessStatus(
  value: unknown,
): value is PermitSafetyReadinessStatus {
  return typeof value === 'string' &&
    (PERMIT_SAFETY_READINESS_STATUSES as readonly string[]).includes(value);
}

export type PermitSafetyRequirementRecord = {
  id: string;
  permitApplicationId: string;
  permitId: string;
  permitReference: string;
  clientId: string;
  buildingId: string;
  applicationStatus: PermitApplicationStatus;
  workType: string;
  currentWorkType: string | null;
  requirementType: string;
  requirementDescription: string;
  required: boolean;
  readinessStatus: PermitSafetyReadinessStatus;
  notes: string | null;
  reference: string | null;
  checklistTemplateId: string | null;
  checklistExecutionId: string | null;
  evidenceRequirementId: string | null;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPermitSafetyRequirement = Omit<
  PermitSafetyRequirementRecord,
  'createdAt' | 'updatedAt'
> & {
  resolvedReadinessStatus: PermitSafetyReadinessStatus;
  checklistStatus: string | null;
  evidenceReady: boolean | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePermitSafetyRequirementInput = {
  buildingId: string;
  workType: string;
  requirementType: string;
  requirementDescription: string;
  required?: boolean;
  readinessStatus?: PermitSafetyReadinessStatus;
  notes?: string | null;
  reference?: string | null;
  checklistTemplateId?: string | null;
  checklistExecutionId?: string | null;
  evidenceRequirementId?: string | null;
};

export type NewPermitSafetyRequirement = {
  permitApplicationId: string;
  workType: string;
  requirementType: string;
  requirementDescription: string;
  required: boolean;
  readinessStatus: PermitSafetyReadinessStatus;
  notes: string | null;
  reference: string | null;
  checklistTemplateId: string | null;
  checklistExecutionId: string | null;
  evidenceRequirementId: string | null;
  actorUserId: string;
};

export type UpdatePermitSafetyReadinessInput = {
  readinessStatus: PermitSafetyReadinessStatus;
  notes?: string | null;
  reference?: string | null;
  checklistTemplateId?: string | null;
  checklistExecutionId?: string | null;
  evidenceRequirementId?: string | null;
};

export type PermitSafetyRequirementFilters = {
  permitId?: string;
  permitApplicationId?: string;
  buildingId?: string;
  workType?: string;
  readinessStatus?: PermitSafetyReadinessStatus;
};

export type PermitSafetyReadiness = {
  permitId: string;
  permitApplicationId: string;
  permitReference: string;
  buildingId: string;
  workType: string | null;
  ready: boolean;
  readinessStatus: 'NOT_CONFIGURED' | 'PENDING' | 'READY' | 'NOT_READY';
  requiredCount: number;
  readyCount: number;
  missingRequirementTypes: string[];
  requirements: PublicPermitSafetyRequirement[];
};
