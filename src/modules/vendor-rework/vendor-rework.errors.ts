import { AppError, ERROR_CODES } from '../../shared/errors';

/** The latest verification is not a REWORK_REQUIRED decision. */
export function vendorReworkInvalidVerificationError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_REWORK_INVALID_VERIFICATION,
    message: 'Rework requires a REWORK_REQUIRED verification.',
    statusCode: 400,
  });
}

/** A current (REQUESTED) rework cycle already exists for this Vendor Work. */
export function vendorReworkAlreadyOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_REWORK_ALREADY_OPEN,
    message: 'This vendor work already has a current rework cycle.',
    statusCode: 409,
  });
}

/** The REWORK_REQUIRED review already has a rework cycle (must re-verify). */
export function vendorReworkReviewConsumedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_REWORK_REVIEW_CONSUMED,
    message: 'This verification already produced a rework cycle.',
    statusCode: 409,
  });
}

/** No current (REQUESTED) rework cycle exists. */
export function vendorReworkNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_REWORK_NOT_FOUND,
    message: 'This vendor work has no current rework cycle.',
    statusCode: 404,
  });
}

/** A RESUBMITTED rework cycle cannot be modified. */
export function vendorReworkImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_REWORK_IMMUTABLE,
    message: 'A completed rework cycle cannot be modified.',
    statusCode: 409,
  });
}

/** The Work Order's Building does not match the Vendor Work's Building. */
export function vendorReworkBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_REWORK_BUILDING_MISMATCH,
    message: 'The work order building does not match the vendor work building.',
    statusCode: 400,
  });
}
