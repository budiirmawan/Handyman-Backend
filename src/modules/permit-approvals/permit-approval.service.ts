import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import { permissionService } from '../permissions';
import { resolvePermitSafetyReadiness } from '../permit-safety-requirements/permit-safety-requirement.service';
import type { ReviewDecision } from '../reviews/review.types';
import { userRepository } from '../users';
import {
  assertPermitApprovalActionAllowed,
  resolvePermitApprovalAuthority,
} from './permit-approval.authority';
import {
  permitApprovalAlreadyDecidedError,
  permitApprovalAlreadyExistsError,
  permitApprovalApproverInvalidError,
  permitApprovalContextInvalidError,
  permitApprovalNotFoundError,
  permitApprovalUnauthorizedApproverError,
} from './permit-approval.errors';
import { permitApprovalRepository } from './permit-approval.repository';
import {
  PERMIT_APPROVAL_ACTIONS,
  type CreatePermitApprovalInput,
  type PermitApprovalAction,
  type PermitApprovalAvailableActions,
  type PermitApprovalContext,
  type PermitApprovalDecisionInput,
  type PermitApprovalPendingFilters,
  type PermitApprovalRecord,
  type PermitApprovalStatus,
  type PublicPermitApproval,
} from './permit-approval.types';

function approvalStatus(record: PermitApprovalRecord): PermitApprovalStatus {
  return record.reviewStatus === 'PENDING'
    ? 'PENDING'
    : record.decision as Exclude<PermitApprovalStatus, 'PENDING'>;
}

export function toPublicPermitApproval(
  record: PermitApprovalRecord,
): PublicPermitApproval {
  return {
    ...record,
    approvalStatus: approvalStatus(record),
    decisionAt: record.decisionAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function canActAsPermitApprover(
  userId: string,
  buildingId: string,
): Promise<boolean> {
  const user = await userRepository.findById(userId);
  if (!user || user.status !== 'ACTIVE') return false;
  if (!(await contextAccessService.canAccessBuilding(userId, buildingId))) {
    return false;
  }
  const permissions = await permissionService.resolvePermissionsForUser(userId);
  return permissions.includes('permit.read') && permissions.includes('permit.approve');
}

function isApprovalUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'permit_approval_context_unique';
}

export async function createPermitApproval(
  permitApplicationId: string,
  input: CreatePermitApprovalInput,
  actorUserId: string,
): Promise<PublicPermitApproval> {
  const application = await permitApplicationRepository.findById(
    permitApplicationId,
  );
  if (!application) throw permitApprovalContextInvalidError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    application.buildingId,
  );
  if (
    application.status !== 'SUBMITTED' ||
    application.permitStatus !== 'DRAFT'
  ) {
    throw permitApprovalContextInvalidError();
  }
  if (!(await canActAsPermitApprover(
    input.approverUserId,
    application.buildingId,
  ))) {
    throw permitApprovalApproverInvalidError();
  }
  if (await permitApprovalRepository.findByApplicationStageType({
    permitApplicationId: application.id,
    approvalStage: input.approvalStage,
    approvalType: input.approvalType,
  })) {
    throw permitApprovalAlreadyExistsError();
  }

  try {
    const created = await permitApprovalRepository.create({
      permitApplicationId: application.id,
      clientId: application.clientId,
      createdByUserId: actorUserId,
      approval: input,
    });
    await recordApprovalEvent(
      created,
      actorUserId,
      'PERMIT_APPROVAL_CREATED',
      'Permit approval context created',
      {
        approvalStage: created.approvalStage,
        approvalType: created.approvalType,
        approverUserId: created.approverUserId,
      },
    );
    return toPublicPermitApproval(created);
  } catch (error) {
    if (isApprovalUniqueViolation(error)) {
      throw permitApprovalAlreadyExistsError();
    }
    throw error;
  }
}

export async function getPermitApproval(
  id: string,
  actorUserId: string,
): Promise<PublicPermitApproval> {
  const record = await permitApprovalRepository.findById(id);
  if (!record) throw permitApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublicPermitApproval(record);
}

export async function resolvePermitApprovalContext(
  permitApplicationId: string,
  actorUserId: string,
): Promise<PermitApprovalContext> {
  const application = await permitApplicationRepository.findById(
    permitApplicationId,
  );
  if (!application) throw permitApprovalContextInvalidError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    application.buildingId,
  );
  const [safetyReadiness, approvals] = await Promise.all([
    resolvePermitSafetyReadiness(application.permitId, actorUserId),
    permitApprovalRepository.listByApplication(application.id),
  ]);
  return {
    permitId: application.permitId,
    permitApplicationId: application.id,
    permitReference: application.permitReference,
    buildingId: application.buildingId,
    applicationStatus: application.status,
    safetyReadiness,
    approvals: approvals.map(toPublicPermitApproval),
  };
}

export async function listPendingPermitApprovals(
  filters: PermitApprovalPendingFilters,
  actorUserId: string,
): Promise<PublicPermitApproval[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await permitApprovalRepository.listPending(filters, buildingIds)
  ).map(toPublicPermitApproval);
}

export async function resolvePermitApprovalAvailableActions(
  id: string,
  actorUserId: string,
): Promise<PermitApprovalAvailableActions> {
  const authority = await resolvePermitApprovalAuthority(id, actorUserId);
  return {
    approvalId: authority.approval.id,
    approvalStatus: approvalStatus(authority.approval),
    applicationStatus: authority.approval.applicationStatus,
    safetyReadinessStatus: authority.safetyReadinessStatus,
    availableActions: PERMIT_APPROVAL_ACTIONS.filter(authority.isAllowed),
  };
}

export async function approvePermitApproval(
  id: string,
  input: PermitApprovalDecisionInput,
  actorUserId: string,
): Promise<PublicPermitApproval> {
  return decide(id, 'APPROVED', 'APPROVE', input, actorUserId);
}

export async function rejectPermitApproval(
  id: string,
  input: PermitApprovalDecisionInput,
  actorUserId: string,
): Promise<PublicPermitApproval> {
  return decide(id, 'REJECTED', 'REJECT', input, actorUserId);
}

export async function requestPermitApprovalRework(
  id: string,
  input: PermitApprovalDecisionInput,
  actorUserId: string,
): Promise<PublicPermitApproval> {
  return decide(id, 'REWORK_REQUIRED', 'REQUEST_REWORK', input, actorUserId);
}

async function decide(
  id: string,
  decision: ReviewDecision,
  action: PermitApprovalAction,
  input: PermitApprovalDecisionInput,
  actorUserId: string,
): Promise<PublicPermitApproval> {
  const existing = await permitApprovalRepository.findById(id);
  if (!existing) throw permitApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.reviewStatus !== 'PENDING' || existing.decision !== null) {
    throw permitApprovalAlreadyDecidedError();
  }
  if (existing.approverUserId !== actorUserId) {
    throw permitApprovalUnauthorizedApproverError();
  }
  await assertPermitApprovalActionAllowed(id, actorUserId, action);

  const completed = await permitApprovalRepository.completeReview(
    existing.reviewId,
    decision,
    input.decisionNotes ?? null,
  );
  if (!completed) throw permitApprovalAlreadyDecidedError();
  const updated = await permitApprovalRepository.findById(id);
  if (!updated) throw permitApprovalNotFoundError();
  await recordApprovalEvent(
    updated,
    actorUserId,
    'PERMIT_APPROVAL_DECIDED',
    `Permit approval decision: ${decision}`,
    {
      fromStatus: 'PENDING',
      toStatus: decision,
      decisionNotes: updated.decisionNotes,
    },
  );
  return toPublicPermitApproval(updated);
}

async function recordApprovalEvent(
  approval: PermitApprovalRecord,
  actorUserId: string,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: approval.clientId,
    buildingId: approval.buildingId,
    entityType: 'PERMIT_APPROVAL',
    entityId: approval.id,
    eventType,
    actorUserId,
    summary,
    metadata: {
      permitId: approval.permitId,
      permitApplicationId: approval.permitApplicationId,
      reviewId: approval.reviewId,
      ...metadata,
    },
  });
}

export const permitApprovalService = {
  approvePermitApproval,
  createPermitApproval,
  getPermitApproval,
  listPendingPermitApprovals,
  rejectPermitApproval,
  requestPermitApprovalRework,
  resolvePermitApprovalAvailableActions,
  resolvePermitApprovalContext,
};
