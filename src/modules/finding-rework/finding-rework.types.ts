export type FindingReworkStatus = 'REQUESTED' | 'RESUBMITTED';

export type FindingReworkRecord = {
  id: string;
  findingId: string;
  reviewId: string;
  requestedByUserId: string;
  reason: string;
  reworkNotes: string | null;
  resubmittedByUserId: string | null;
  requestedAt: Date;
  resubmittedAt: Date | null;
  status: FindingReworkStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicFindingRework = Omit<
  FindingReworkRecord,
  'requestedAt' | 'resubmittedAt' | 'createdAt' | 'updatedAt'
> & {
  requestedAt: string;
  resubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FindingReworkContext = {
  findingId: string;
  findingState: string;
  current: PublicFindingRework | null;
  cycles: PublicFindingRework[];
};
