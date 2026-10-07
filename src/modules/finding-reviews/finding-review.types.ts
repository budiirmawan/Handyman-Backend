import type { ReviewDecision } from '../reviews';

export type FindingReviewStatus = 'PENDING' | 'COMPLETED';
export type FindingReviewRecord = {
  id: string;
  clientId: string;
  findingId: string;
  reviewerUserId: string;
  decision: ReviewDecision | null;
  notes: string | null;
  reviewedAt: Date | null;
  status: FindingReviewStatus;
  createdAt: Date;
  updatedAt: Date;
};
export type PublicFindingReview = Omit<
  FindingReviewRecord,
  'reviewedAt' | 'createdAt' | 'updatedAt'
> & {
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type OpenFindingReviewInput = {
  findingId: string;
  reviewerUserId: string;
  notes?: string;
};
export type SubmitFindingVerificationInput = {
  findingId: string;
  reviewerUserId: string;
  decision: ReviewDecision;
  notes?: string;
};
export type FindingVerificationState = {
  findingId: string;
  state: string;
  currentReview: PublicFindingReview | null;
  latestVerification: PublicFindingReview | null;
  reviews: PublicFindingReview[];
};
