import { AppError, ERROR_CODES } from '../../shared/errors';
export function findingReviewInvalidStateError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REVIEW_INVALID_STATE, message: 'Finding is not in a reviewable state.', statusCode: 400 });
}
export function findingReviewAlreadyOpenError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REVIEW_ALREADY_OPEN, message: 'Finding already has a pending review.', statusCode: 409 });
}
export function findingReviewNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REVIEW_NOT_FOUND, message: 'Finding has no pending review.', statusCode: 404 });
}
export function findingReviewImmutableError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REVIEW_IMMUTABLE, message: 'Completed verification cannot be overwritten.', statusCode: 409 });
}
export function findingReviewReviewerMismatchError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REVIEW_REVIEWER_MISMATCH, message: 'Only the assigned reviewer may submit this verification.', statusCode: 403 });
}
