import { isUserActiveFindingAssignee } from '../finding-assignments/finding-assignment.authority';
import { recordFindingEvent } from '../finding-history/finding-history.service';
import { findingReviewService } from '../finding-reviews';
import {
  findingNotFoundError,
  findingRepository,
  findingStateService,
} from '../findings';
import {
  findingReworkAlreadyOpenError,
  findingReworkImmutableError,
  findingReworkInvalidStateError,
  findingReworkNotFoundError,
  findingReworkUnauthorizedError,
} from './finding-rework.errors';
import { findingReworkRepository } from './finding-rework.repository';
import type {
  FindingReworkContext,
  FindingReworkRecord,
  PublicFindingRework,
} from './finding-rework.types';

export function toPublicFindingRework(row: FindingReworkRecord): PublicFindingRework {
  return {
    ...row,
    requestedAt: row.requestedAt.toISOString(),
    resubmittedAt: row.resubmittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function loadFinding(findingId: string) {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  return finding;
}
export async function rejectFinding(input: {
  findingId: string;
  userId: string;
  reason: string;
}) {
  const finding = await loadFinding(input.findingId);
  if (finding.status !== 'PENDING_REVIEW') throw findingReworkInvalidStateError();
  const result = await findingReviewService.submitFindingVerification({
    findingId: finding.id,
    reviewerUserId: input.userId,
    decision: 'REJECTED',
    notes: input.reason,
  });
  const state = await findingStateService.transitionFindingState(
    finding.id,
    { state: 'REJECTED' },
    input.userId,
  );
  await recordFindingEvent({
    findingId: finding.id,
    clientId: finding.clientId,
    buildingId: finding.buildingId,
    eventType: 'FINDING_REJECTED',
    actorUserId: input.userId,
    summary: 'Finding rejected',
    metadata: { reviewId: result.verification.id },
  });
  return { verification: result.verification, state: state.state };
}
export async function requestFindingRework(input: {
  findingId: string;
  userId: string;
  reason: string;
}): Promise<{ rework: PublicFindingRework; state: string }> {
  const finding = await loadFinding(input.findingId);
  if (await findingReworkRepository.findCurrent(finding.id)) {
    throw findingReworkAlreadyOpenError();
  }

  let reviewId: string;
  if (finding.status === 'PENDING_REVIEW') {
    const verification = await findingReviewService.submitFindingVerification({
      findingId: finding.id,
      reviewerUserId: input.userId,
      decision: 'REWORK_REQUIRED',
      notes: input.reason,
    });
    reviewId = verification.verification.id;
  } else if (finding.status === 'REJECTED') {
    const verification = await findingReviewService.getFindingVerificationState(
      finding.id,
    );
    if (verification.latestVerification?.decision !== 'REJECTED') {
      throw findingReworkInvalidStateError();
    }
    reviewId = verification.latestVerification.id;
  } else {
    throw findingReworkInvalidStateError();
  }

  const state = await findingStateService.transitionFindingState(
    finding.id,
    { state: 'REWORK_REQUIRED' },
    input.userId,
  );
  try {
    const cycle = await findingReworkRepository.create({
      findingId: finding.id,
      reviewId,
      requestedByUserId: input.userId,
      reason: input.reason,
    });
    await recordFindingEvent({
      findingId: finding.id,
      clientId: finding.clientId,
      buildingId: finding.buildingId,
      eventType: 'FINDING_REWORK_REQUESTED',
      actorUserId: input.userId,
      summary: 'Finding rework requested',
      metadata: { reviewId, reworkCycleId: cycle.id },
    });
    return { rework: toPublicFindingRework(cycle), state: state.state };
  } catch (error) {
    if (isCurrentUnique(error)) throw findingReworkAlreadyOpenError();
    throw error;
  }
}
export async function getFindingReworkContext(
  findingId: string,
): Promise<FindingReworkContext> {
  const finding = await loadFinding(findingId);
  const cycles = (await findingReworkRepository.listByFindingId(finding.id)).map(
    toPublicFindingRework,
  );
  return {
    findingId: finding.id,
    findingState: finding.status,
    current: [...cycles].reverse().find((cycle) => cycle.status === 'REQUESTED') ?? null,
    cycles,
  };
}
export async function updateFindingReworkNotes(input: {
  findingId: string;
  userId: string;
  notes: string;
}): Promise<PublicFindingRework> {
  const finding = await loadFinding(input.findingId);
  if (finding.status !== 'REWORK_REQUIRED') throw findingReworkInvalidStateError();
  const cycle = await findingReworkRepository.findCurrent(finding.id);
  if (!cycle) throw findingReworkNotFoundError();
  if (!(await isUserActiveFindingAssignee(finding.id, input.userId))) {
    throw findingReworkUnauthorizedError();
  }
  const updated = await findingReworkRepository.updateNotes(cycle.id, input.notes);
  if (!updated) throw findingReworkImmutableError();
  await recordFindingEvent({
    findingId: finding.id,
    clientId: finding.clientId,
    buildingId: finding.buildingId,
    eventType: 'FINDING_REWORK_NOTES_UPDATED',
    actorUserId: input.userId,
    summary: 'Finding rework notes updated',
    metadata: { reworkCycleId: cycle.id },
  });
  return toPublicFindingRework(updated);
}
export async function resubmitFinding(input: {
  findingId: string;
  userId: string;
  notes: string;
}): Promise<{ rework: PublicFindingRework; state: string }> {
  const finding = await loadFinding(input.findingId);
  if (finding.status !== 'REWORK_REQUIRED') throw findingReworkInvalidStateError();
  const cycle = await findingReworkRepository.findCurrent(finding.id);
  if (!cycle) throw findingReworkNotFoundError();
  if (!(await isUserActiveFindingAssignee(finding.id, input.userId))) {
    throw findingReworkUnauthorizedError();
  }

  await findingStateService.transitionFindingState(
    finding.id,
    { state: 'RESUBMITTED' },
    input.userId,
  );
  const state = await findingStateService.transitionFindingState(
    finding.id,
    { state: 'PENDING_REVIEW' },
    input.userId,
  );
  const updated = await findingReworkRepository.markResubmitted(
    cycle.id,
    input.userId,
    input.notes,
  );
  if (!updated) throw findingReworkImmutableError();
  await recordFindingEvent({
    findingId: finding.id,
    clientId: finding.clientId,
    buildingId: finding.buildingId,
    eventType: 'FINDING_RESUBMITTED',
    actorUserId: input.userId,
    summary: 'Finding resubmitted for review',
    metadata: { reworkCycleId: cycle.id },
  });
  return { rework: toPublicFindingRework(updated), state: state.state };
}

function isCurrentUnique(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return value?.code === '23505' &&
    (value.constraint === 'finding_current_rework_unique' ||
      value.constraint === 'finding_rework_review_unique');
}
export const findingReworkService = {
  getFindingReworkContext,
  rejectFinding,
  requestFindingRework,
  resubmitFinding,
  toPublicFindingRework,
  updateFindingReworkNotes,
};
