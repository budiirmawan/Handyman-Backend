import type { FindingStatus } from './finding.types';

export type FindingState = {
  findingId: string;
  state: FindingStatus;
  stateChangedAt: string;
};

export type TransitionFindingStateInput = {
  state: FindingStatus;
};
