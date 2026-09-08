import type { PermitApplicationStatus } from '../permit-applications/permit-application.types';
import type { PermitSafetyReadiness } from '../permit-safety-requirements/permit-safety-requirement.types';
import type { ReviewDecision } from '../reviews/review.types';

export const PERMIT_APPROVAL_ACTIONS = [
  'APPROVE',
  'REJECT',
  'REQUEST_REWORK',
] as const;
export type PermitApprovalAction = (typeof PERMIT_APPROVAL_ACTIONS)[number];

export const PERMIT_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'REWORK_REQUIRED',
] as const;
export type PermitApprovalStatus = (typeof PERMIT_APPROVAL_STATUSES)[number];

export type PermitApprovalRecord = {
  id: string;
  reviewId: string;
  permitApplicationId: string;
  permitId: string;
  permitReference: string;
  clientId: string;
  buildingId: string;
  contractorContextType: string;
  contractorVendorId: string;
  applicationStatus: PermitApplicationStatus;
  permitStatus: string;
  approvalStage: string;
  approvalType: string;
  approverUserId: string;
  reviewStatus: 'PENDING' | 'COMPLETED';
  decision: ReviewDecision | null;
  decisionAt: Date | null;
  decisionNotes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPermitApproval = Omit<
  PermitApprovalRecord,
  'decisionAt' | 'createdAt' | 'updatedAt'
> & {
  approvalStatus: PermitApprovalStatus;
  decisionAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePermitApprovalInput = {
  approvalStage: string;
  approvalType: string;
  approverUserId: string;
  notes?: string | null;
};

export type PermitApprovalDecisionInput = {
  decisionNotes?: string | null;
};

export type PermitApprovalPendingFilters = {
  buildingId?: string;
  approverUserId?: string;
  approvalStage?: string;
  approvalType?: string;
};

export type PermitApprovalAvailableActions = {
  approvalId: string;
  approvalStatus: PermitApprovalStatus;
  applicationStatus: PermitApplicationStatus;
  safetyReadinessStatus: PermitSafetyReadiness['readinessStatus'];
  availableActions: PermitApprovalAction[];
};

export type PermitApprovalContext = {
  permitId: string;
  permitApplicationId: string;
  permitReference: string;
  buildingId: string;
  applicationStatus: PermitApplicationStatus;
  safetyReadiness: PermitSafetyReadiness;
  approvals: PublicPermitApproval[];
};
