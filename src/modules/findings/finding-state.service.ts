import { findingAssignmentRepository } from '../finding-assignments/finding-assignment.repository';
import { recordFindingEvent } from '../finding-history/finding-history.service';
import {
  findingInvalidTransitionError,
  findingNotFoundError,
  findingStateAssignmentRequiredError,
} from './finding.errors';
import { findingRepository } from './finding.repository';
import type {
  FindingState,
  TransitionFindingStateInput,
} from './finding-state.types';
import {
  canTransitionFindingStatus,
  type FindingStatus,
} from './finding.types';

const ASSIGNMENT_REQUIRED_STATES: readonly FindingStatus[] = [
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REWORK_REQUIRED',
  'RESUBMITTED',
];

export async function getFindingState(findingId: string): Promise<FindingState> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  return {
    findingId: finding.id,
    state: finding.status,
    stateChangedAt: finding.stateChangedAt.toISOString(),
  };
}

export async function transitionFindingState(
  findingId: string,
  input: TransitionFindingStateInput,
  actorUserId?: string,
): Promise<FindingState> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  // BE-09H owns the controlled closure path so closure metadata and approved
  // verification are mandatory. The generic state endpoint cannot close.
  if (input.state === 'CLOSED') {
    throw findingInvalidTransitionError(finding.status, input.state);
  }
  if (!canTransitionFindingStatus(finding.status, input.state)) {
    throw findingInvalidTransitionError(finding.status, input.state);
  }

  if (ASSIGNMENT_REQUIRED_STATES.includes(input.state)) {
    const assignment = await findingAssignmentRepository.findActiveByFindingId(
      finding.id,
    );
    if (!assignment) throw findingStateAssignmentRequiredError();
  }

  const updated = await findingRepository.transitionStatus(
    finding.id,
    finding.status,
    input.state,
  );
  if (!updated) {
    throw findingInvalidTransitionError(finding.status, input.state);
  }
  await recordFindingEvent({
    findingId: finding.id,
    clientId: finding.clientId,
    buildingId: finding.buildingId,
    eventType: 'FINDING_STATE_CHANGED',
    actorUserId,
    summary: `Finding state changed from ${finding.status} to ${input.state}`,
    metadata: { fromState: finding.status, toState: input.state },
  });
  if (input.state === 'CANCELLED') {
    await recordFindingEvent({
      findingId: finding.id,
      clientId: finding.clientId,
      buildingId: finding.buildingId,
      eventType: 'FINDING_CANCELLED',
      actorUserId,
      summary: 'Finding cancelled',
      metadata: { fromState: finding.status },
    });
  }
  return {
    findingId: updated.id,
    state: updated.status,
    stateChangedAt: updated.stateChangedAt.toISOString(),
  };
}

export const findingStateService = {
  getFindingState,
  transitionFindingState,
};
