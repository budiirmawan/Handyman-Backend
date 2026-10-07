import { recordFindingEvent } from '../finding-history/finding-history.service';
import { findingReviewService } from '../finding-reviews/finding-review.service';
import { findingReworkRepository } from '../finding-rework/finding-rework.repository';
import { findingNotFoundError } from '../findings/finding.errors';
import { findingRepository } from '../findings/finding.repository';
import { canTransitionFindingStatus } from '../findings/finding.types';
import {
  findingCloseAlreadyClosedError,
  findingCloseInvalidStateError,
  findingCloseNotApprovedError,
  findingCloseReworkPendingError,
} from './finding-closure.errors';
import type {
  CloseFindingInput,
  FindingClosureInfo,
} from './finding-closure.types';

export async function getFindingClosureInfo(
  findingId: string,
): Promise<FindingClosureInfo> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  const verification = await findingReviewService.getFindingVerificationState(
    finding.id,
  );
  const pendingRework = await findingReworkRepository.findCurrent(finding.id);
  const approved = verification.latestVerification?.decision === 'APPROVED';
  return {
    findingId: finding.id,
    state: finding.status,
    ready:
      finding.status === 'VERIFIED' && approved && pendingRework === null,
    latestVerificationId: verification.latestVerification?.id ?? null,
    latestVerificationDecision:
      verification.latestVerification?.decision ?? null,
    reworkPending: pendingRework !== null,
    closedAt: finding.closedAt?.toISOString() ?? null,
    closedByUserId: finding.closedByUserId,
    closureNotes: finding.closureNotes,
  };
}

export async function closeFinding(
  input: CloseFindingInput,
): Promise<FindingClosureInfo> {
  const finding = await findingRepository.findById(input.findingId);
  if (!finding) throw findingNotFoundError();
  if (finding.status === 'CLOSED') throw findingCloseAlreadyClosedError();

  const pendingRework = await findingReworkRepository.findCurrent(finding.id);
  if (pendingRework) throw findingCloseReworkPendingError();
  if (
    finding.status !== 'VERIFIED' ||
    !canTransitionFindingStatus(finding.status, 'CLOSED')
  ) {
    throw findingCloseInvalidStateError();
  }

  const verification = await findingReviewService.getFindingVerificationState(
    finding.id,
  );
  if (verification.latestVerification?.decision !== 'APPROVED') {
    throw findingCloseNotApprovedError();
  }

  const closed = await findingRepository.closeVerified(
    finding.id,
    input.closedByUserId,
    input.closureNotes?.trim() || null,
  );
  if (!closed) throw findingCloseInvalidStateError();
  await recordFindingEvent({
    findingId: closed.id,
    clientId: closed.clientId,
    buildingId: closed.buildingId,
    eventType: 'FINDING_CLOSED',
    actorUserId: input.closedByUserId,
    summary: 'Finding closed',
    metadata: {
      latestVerificationId: verification.latestVerification.id,
    },
  });
  return {
    findingId: closed.id,
    state: closed.status,
    ready: false,
    latestVerificationId: verification.latestVerification.id,
    latestVerificationDecision: verification.latestVerification.decision,
    reworkPending: false,
    closedAt: closed.closedAt?.toISOString() ?? null,
    closedByUserId: closed.closedByUserId,
    closureNotes: closed.closureNotes,
  };
}

export const findingClosureService = {
  closeFinding,
  getFindingClosureInfo,
};
