import { recordFindingEvent } from '../finding-history/finding-history.service';
import { findingNotFoundError } from '../findings/finding.errors';
import { findingRepository } from '../findings/finding.repository';
import { findingStateService } from '../findings/finding-state.service';
import {
  findingReviewAlreadyOpenError,
  findingReviewImmutableError,
  findingReviewInvalidStateError,
  findingReviewNotFoundError,
  findingReviewReviewerMismatchError,
} from './finding-review.errors';
import { findingReviewRepository } from './finding-review.repository';
import type {
  FindingReviewRecord,
  FindingVerificationState,
  OpenFindingReviewInput,
  PublicFindingReview,
  SubmitFindingVerificationInput,
} from './finding-review.types';

export function toPublicFindingReview(row: FindingReviewRecord): PublicFindingReview {
  return {
    ...row,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function loadFinding(findingId: string) {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  return finding;
}
export async function openFindingReview(
  input: OpenFindingReviewInput,
): Promise<PublicFindingReview> {
  const finding = await loadFinding(input.findingId);
  if (finding.status !== 'PENDING_REVIEW') throw findingReviewInvalidStateError();
  if (await findingReviewRepository.findPendingByFindingId(finding.id)) {
    throw findingReviewAlreadyOpenError();
  }
  try {
    const review = await findingReviewRepository.createPending({
      clientId: finding.clientId,
      findingId: finding.id,
      reviewerUserId: input.reviewerUserId,
      notes: input.notes?.trim() || null,
    });
    await recordFindingEvent({
      findingId: finding.id,
      clientId: finding.clientId,
      buildingId: finding.buildingId,
      eventType: 'FINDING_REVIEW_OPENED',
      actorUserId: input.reviewerUserId,
      summary: 'Finding review opened',
      metadata: { reviewId: review.id },
    });
    return toPublicFindingReview(review);
  } catch (error) {
    if (isPendingUnique(error)) throw findingReviewAlreadyOpenError();
    throw error;
  }
}
export async function listFindingReviews(findingId: string): Promise<PublicFindingReview[]> {
  await loadFinding(findingId);
  return (await findingReviewRepository.listByFindingId(findingId)).map(toPublicFindingReview);
}
export async function getCurrentFindingReview(findingId: string): Promise<PublicFindingReview | null> {
  await loadFinding(findingId);
  const row = await findingReviewRepository.findPendingByFindingId(findingId);
  return row ? toPublicFindingReview(row) : null;
}
export async function getFindingVerificationState(
  findingId: string,
): Promise<FindingVerificationState> {
  const finding = await loadFinding(findingId);
  const reviews = (await findingReviewRepository.listByFindingId(findingId)).map(toPublicFindingReview);
  const currentReview = [...reviews].reverse().find((review) => review.status === 'PENDING') ?? null;
  const latestVerification = [...reviews].reverse().find((review) => review.status === 'COMPLETED') ?? null;
  return { findingId, state: finding.status, currentReview, latestVerification, reviews };
}
export async function submitFindingVerification(
  input: SubmitFindingVerificationInput,
): Promise<{ verification: PublicFindingReview; state: string }> {
  const finding = await loadFinding(input.findingId);
  if (finding.status !== 'PENDING_REVIEW') throw findingReviewInvalidStateError();
  const pending = await findingReviewRepository.findPendingByFindingId(finding.id);
  if (!pending) {
    const reviews = await findingReviewRepository.listByFindingId(finding.id);
    if (reviews.some((review) => review.status === 'COMPLETED')) {
      throw findingReviewImmutableError();
    }
    throw findingReviewNotFoundError();
  }
  if (pending.reviewerUserId !== input.reviewerUserId) {
    throw findingReviewReviewerMismatchError();
  }
  const completed = await findingReviewRepository.complete(
    pending.id,
    input.decision,
    input.notes?.trim() || pending.notes,
  );
  if (!completed) throw findingReviewImmutableError();
  await recordFindingEvent({
    findingId: finding.id,
    clientId: finding.clientId,
    buildingId: finding.buildingId,
    eventType: 'FINDING_VERIFICATION_SUBMITTED',
    actorUserId: input.reviewerUserId,
    summary: `Finding verification decision submitted: ${input.decision}`,
    metadata: { reviewId: completed.id, decision: input.decision },
  });

  let state: string = finding.status;
  if (input.decision === 'APPROVED') {
    state = (await findingStateService.transitionFindingState(
      finding.id,
      { state: 'VERIFIED' },
      input.reviewerUserId,
    )).state;
    await recordFindingEvent({
      findingId: finding.id,
      clientId: finding.clientId,
      buildingId: finding.buildingId,
      eventType: 'FINDING_VERIFIED',
      actorUserId: input.reviewerUserId,
      summary: 'Finding verified',
      metadata: { reviewId: completed.id },
    });
  }
  return { verification: toPublicFindingReview(completed), state };
}
function isPendingUnique(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return value?.code === '23505' && value.constraint === 'finding_pending_review_unique';
}
export const findingReviewService = {
  getCurrentFindingReview,
  getFindingVerificationState,
  listFindingReviews,
  openFindingReview,
  submitFindingVerification,
  toPublicFindingReview,
};
