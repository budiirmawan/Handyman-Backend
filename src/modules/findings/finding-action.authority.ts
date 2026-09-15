import { AppError, ERROR_CODES } from '../../shared/errors';
import { findingAssignmentRepository } from '../finding-assignments/finding-assignment.repository';
import { isUserActiveFindingAssignee } from '../finding-assignments/finding-assignment.authority';
import { findingClosureService } from '../finding-closure/finding-closure.service';
import { findingReviewService } from '../finding-reviews/finding-review.service';
import { findingReworkRepository } from '../finding-rework/finding-rework.repository';
import { permissionService } from '../permissions';
import { contextAccessService } from '../context-access';
import { findingNotFoundError } from './finding.errors';
import { findingRepository } from './finding.repository';
import type { FindingAction } from './finding-action.types';
import { canTransitionFindingStatus } from './finding.types';

export const FINDING_ACTION_PERMISSIONS: Record<FindingAction, string> = {
  ASSIGN: 'finding.assign',
  MARK_ASSIGNED: 'finding.assign',
  START: 'finding.execute',
  SUBMIT_FOR_REVIEW: 'finding.execute',
  OPEN_REVIEW: 'finding.review',
  APPROVE: 'finding.review',
  REJECT: 'finding.review',
  REQUEST_REWORK: 'finding.review',
  RESUBMIT: 'finding.execute',
  CLOSE: 'finding.close',
  CANCEL: 'finding.manage',
};

export type FindingActionAuthority = {
  findingId: string;
  state: import('./finding.types').FindingStatus;
  isAllowed: (action: FindingAction) => boolean;
};

/**
 * Resolves final backend authority for each existing Finding action. Position
 * names, Team names, and client-provided roles are never authority inputs.
 */
export async function resolveFindingActionAuthority(
  findingId: string,
  userId: string,
): Promise<FindingActionAuthority> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  await contextAccessService.assertBuildingAccess(userId, finding.buildingId);

  const [permissions, assignment, isAssignee, verification, currentRework] =
    await Promise.all([
      permissionService.resolvePermissionsForUser(userId),
      findingAssignmentRepository.findActiveByFindingId(finding.id),
      isUserActiveFindingAssignee(finding.id, userId),
      findingReviewService.getFindingVerificationState(finding.id),
      findingReworkRepository.findCurrent(finding.id),
    ]);
  const permissionSet = new Set(permissions);
  const canRead = permissionSet.has('finding.read');
  const canTransition = (
    state: Parameters<typeof canTransitionFindingStatus>[1],
  ) => canTransitionFindingStatus(finding.status, state);

  const stateAllows = (action: FindingAction): boolean => {
    switch (action) {
      case 'ASSIGN':
        return finding.status === 'OPEN';
      case 'MARK_ASSIGNED':
        return finding.status === 'OPEN' && assignment !== null &&
          canTransition('ASSIGNED');
      case 'START':
        return finding.status === 'ASSIGNED' && isAssignee &&
          canTransition('IN_PROGRESS');
      case 'SUBMIT_FOR_REVIEW':
        return (finding.status === 'IN_PROGRESS' ||
            finding.status === 'RESUBMITTED') &&
          isAssignee && canTransition('PENDING_REVIEW');
      case 'OPEN_REVIEW':
        return finding.status === 'PENDING_REVIEW' &&
          verification.currentReview === null;
      case 'APPROVE':
        return finding.status === 'PENDING_REVIEW' &&
          verification.currentReview?.reviewerUserId === userId &&
          canTransition('VERIFIED');
      case 'REJECT':
        return finding.status === 'PENDING_REVIEW' &&
          verification.currentReview?.reviewerUserId === userId &&
          canTransition('REJECTED');
      case 'REQUEST_REWORK':
        if (currentRework !== null) return false;
        if (finding.status === 'PENDING_REVIEW') {
          return verification.currentReview?.reviewerUserId === userId &&
            canTransition('REWORK_REQUIRED');
        }
        return finding.status === 'REJECTED' &&
          verification.latestVerification?.decision === 'REJECTED' &&
          verification.latestVerification.reviewerUserId === userId &&
          canTransition('REWORK_REQUIRED');
      case 'RESUBMIT':
        return finding.status === 'REWORK_REQUIRED' && currentRework !== null &&
          isAssignee && canTransition('RESUBMITTED');
      case 'CLOSE':
        return false; // Resolved asynchronously below.
      case 'CANCEL':
        return canTransition('CANCELLED');
    }
  };

  const allowed = new Set<FindingAction>();
  for (const action of Object.keys(FINDING_ACTION_PERMISSIONS) as FindingAction[]) {
    if (
      canRead &&
      action !== 'CLOSE' &&
      permissionSet.has(FINDING_ACTION_PERMISSIONS[action]) &&
      stateAllows(action)
    ) {
      allowed.add(action);
    }
  }
  if (
    canRead &&
    permissionSet.has(FINDING_ACTION_PERMISSIONS.CLOSE) &&
    finding.status === 'VERIFIED' &&
    canTransition('CLOSED') &&
    (await findingClosureService.getFindingClosureInfo(finding.id)).ready
  ) {
    allowed.add('CLOSE');
  }

  return {
    findingId: finding.id,
    state: finding.status,
    isAllowed: (action) => allowed.has(action),
  };
}

function actionNotAllowed(action: string): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_ACTION_NOT_ALLOWED,
    message: `Finding action ${action} is not allowed.`,
    statusCode: 403,
  });
}

export async function assertFindingActionAllowed(
  findingId: string,
  userId: string,
  action: FindingAction,
): Promise<void> {
  const authority = await resolveFindingActionAuthority(findingId, userId);
  if (!authority.isAllowed(action)) throw actionNotAllowed(action);
}

export async function assertFindingTransitionAllowed(
  findingId: string,
  userId: string,
  from: import('./finding.types').FindingStatus,
  to: import('./finding.types').FindingStatus,
): Promise<void> {
  let action: FindingAction | null = null;
  if (to === 'CANCELLED') action = 'CANCEL';
  else if (from === 'OPEN' && to === 'ASSIGNED') action = 'MARK_ASSIGNED';
  else if (from === 'ASSIGNED' && to === 'IN_PROGRESS') action = 'START';
  else if (
    (from === 'IN_PROGRESS' || from === 'RESUBMITTED') &&
    to === 'PENDING_REVIEW'
  ) action = 'SUBMIT_FOR_REVIEW';
  if (!action) throw actionNotAllowed(`${from}_TO_${to}`);
  await assertFindingActionAllowed(findingId, userId, action);
}
