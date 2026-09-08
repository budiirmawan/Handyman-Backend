import { AppError, ERROR_CODES } from '../../shared/errors';

/** The Vendor Work is not COMPLETED, so it cannot be verified. */
export function vendorVerificationInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_VERIFICATION_INVALID_STATE,
    message: 'Only completed vendor work can be verified.',
    statusCode: 400,
  });
}

/** The Vendor Work is already APPROVED and cannot be re-verified. */
export function vendorVerificationAlreadyApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_VERIFICATION_ALREADY_APPROVED,
    message: 'This vendor work is already approved and cannot be re-verified.',
    statusCode: 409,
  });
}

/** A Completion Report exists but has not been SUBMITTED yet. */
export function vendorVerificationCompletionNotSubmittedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_VERIFICATION_COMPLETION_NOT_SUBMITTED,
    message: 'The completion report must be submitted before verification.',
    statusCode: 400,
  });
}

/**
 * The Work Order's Building does not match the Vendor Work's Building.
 */
export function vendorVerificationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_VERIFICATION_BUILDING_MISMATCH,
    message: 'The work order building does not match the vendor work building.',
    statusCode: 400,
  });
}
