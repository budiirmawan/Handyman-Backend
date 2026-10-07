import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18K — Utility Verification error contract. */

export function utilityVerificationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_VERIFICATION_NOT_FOUND,
    message: 'Utility verification not found.',
    statusCode: 404,
  });
}

/**
 * The target is not a reviewable utility context: the abnormal consumption is
 * unknown, or it has already been closed. A closed detection has had its
 * operational decision made, so there is nothing left to verify.
 */
export function utilityVerificationContextInvalidError(
  message = 'This abnormal consumption is not in a reviewable state.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_VERIFICATION_CONTEXT_INVALID,
    message,
    statusCode: 400,
  });
}

/** A PENDING review is already open for this abnormal consumption. */
export function utilityVerificationAlreadyOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_VERIFICATION_ALREADY_OPEN,
    message: 'A verification is already open for this abnormal consumption.',
    statusCode: 409,
  });
}

/**
 * A COMPLETED verification is final. Overwriting it in place would erase a
 * decision that has already been recorded and acted on.
 */
export function utilityVerificationAlreadyCompletedError(
  message = 'This verification is already completed and cannot be changed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_VERIFICATION_ALREADY_COMPLETED,
    message,
    statusCode: 409,
  });
}

/**
 * The submitter is not the reviewer the pending review was opened for. The
 * reviewer of record must be the one who decides.
 */
export function utilityVerificationReviewerMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_VERIFICATION_REVIEWER_MISMATCH,
    message:
      'Only the assigned reviewer can submit this verification decision.',
    statusCode: 403,
  });
}

/**
 * The utility context is internally inconsistent — the abnormality, its
 * consumption and its meter do not agree on Client, Building or Tenant.
 */
export function utilityVerificationContextMismatchError(
  message = 'The abnormal consumption context does not match its meter or building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_VERIFICATION_CONTEXT_MISMATCH,
    message,
    statusCode: 400,
  });
}
