export const FINDING_ACTIONS = [
  'ASSIGN',
  'MARK_ASSIGNED',
  'START',
  'SUBMIT_FOR_REVIEW',
  'OPEN_REVIEW',
  'APPROVE',
  'REJECT',
  'REQUEST_REWORK',
  'RESUBMIT',
  'CLOSE',
  'CANCEL',
] as const;

export type FindingAction = (typeof FINDING_ACTIONS)[number];

export type FindingAvailableActions = {
  findingId: string;
  state: string;
  availableActions: FindingAction[];
};
