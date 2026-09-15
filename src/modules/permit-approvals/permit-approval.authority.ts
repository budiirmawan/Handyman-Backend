import { contextAccessService } from '../context-access';
import { permissionService } from '../permissions';
import { resolvePermitSafetyReadiness } from '../permit-safety-requirements/permit-safety-requirement.service';
import {
  permitApprovalActionNotAllowedError,
  permitApprovalNotFoundError,
  permitApprovalSafetyNotReadyError,
} from './permit-approval.errors';
import { permitApprovalRepository } from './permit-approval.repository';
import type {
  PermitApprovalAction,
  PermitApprovalRecord,
} from './permit-approval.types';

export const PERMIT_APPROVAL_ACTION_PERMISSIONS: Record<
  PermitApprovalAction,
  string
> = {
  APPROVE: 'permit.approve',
  REJECT: 'permit.approve',
  REQUEST_REWORK: 'permit.approve',
};

export type PermitApprovalAuthority = {
  approval: PermitApprovalRecord;
  safetyReadinessStatus: Awaited<
    ReturnType<typeof resolvePermitSafetyReadiness>
  >['readinessStatus'];
  safetyReady: boolean;
  assignedApprover: boolean;
  isAllowed: (action: PermitApprovalAction) => boolean;
};

/** BE-09-style backend authority and deterministic available-actions source. */
export async function resolvePermitApprovalAuthority(
  approvalId: string,
  actorUserId: string,
): Promise<PermitApprovalAuthority> {
  const approval = await permitApprovalRepository.findById(approvalId);
  if (!approval) throw permitApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    approval.buildingId,
  );

  const [permissions, safetyReadiness] = await Promise.all([
    permissionService.resolvePermissionsForUser(actorUserId),
    resolvePermitSafetyReadiness(approval.permitId, actorUserId),
  ]);
  const permissionSet = new Set(permissions);
  const assignedApprover = approval.approverUserId === actorUserId;
  const pending = approval.reviewStatus === 'PENDING' &&
    approval.decision === null;
  const contextAllowsDecision = pending &&
    approval.applicationStatus === 'SUBMITTED' &&
    approval.permitStatus === 'DRAFT';
  const canRead = permissionSet.has('permit.read');
  const canApprove = permissionSet.has('permit.approve');
  const safetyReady = safetyReadiness.ready;

  return {
    approval,
    safetyReadinessStatus: safetyReadiness.readinessStatus,
    safetyReady,
    assignedApprover,
    isAllowed: (action) =>
      canRead &&
      canApprove &&
      assignedApprover &&
      contextAllowsDecision &&
      (action !== 'APPROVE' || safetyReady),
  };
}

export async function assertPermitApprovalActionAllowed(
  approvalId: string,
  actorUserId: string,
  action: PermitApprovalAction,
): Promise<PermitApprovalAuthority> {
  const authority = await resolvePermitApprovalAuthority(
    approvalId,
    actorUserId,
  );
  if (action === 'APPROVE' && !authority.safetyReady) {
    throw permitApprovalSafetyNotReadyError();
  }
  if (!authority.isAllowed(action)) {
    throw permitApprovalActionNotAllowedError(action);
  }
  return authority;
}
