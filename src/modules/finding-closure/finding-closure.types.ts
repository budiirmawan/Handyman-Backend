import type { ReviewDecision } from '../reviews';

export type FindingClosureInfo = {
  findingId: string;
  state: string;
  ready: boolean;
  latestVerificationId: string | null;
  latestVerificationDecision: ReviewDecision | null;
  reworkPending: boolean;
  closedAt: string | null;
  closedByUserId: string | null;
  closureNotes: string | null;
};

export type CloseFindingInput = {
  findingId: string;
  closedByUserId: string;
  closureNotes?: string;
};
