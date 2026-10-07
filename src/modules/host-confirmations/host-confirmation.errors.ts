import { AppError, ERROR_CODES } from '../../shared/errors';

/** The host confirmation row could not be located. */
export function hostConfirmationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOST_CONFIRMATION_NOT_FOUND,
    message: 'Host confirmation not found.',
    statusCode: 404,
  });
}

/** Exactly one visit reference must be supplied. */
export function hostConfirmationVisitReferenceRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOST_CONFIRMATION_VISIT_REFERENCE_REQUIRED,
    message:
      'Exactly one of expectedVisitorId or walkInVisitId is required.',
    statusCode: 400,
  });
}

/** The referenced visit is cancelled and cannot be confirmed. */
export function hostConfirmationVisitCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOST_CONFIRMATION_VISIT_CANCELLED,
    message: 'A cancelled visit cannot receive a host confirmation.',
    statusCode: 400,
  });
}

/** A confirmation already exists for this visit. */
export function hostConfirmationAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOST_CONFIRMATION_ALREADY_EXISTS,
    message: 'A host confirmation already exists for this visit.',
    statusCode: 409,
  });
}

/** No host reference present after defaulting from the visit. */
export function hostConfirmationHostRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOST_CONFIRMATION_HOST_REQUIRED,
    message:
      'At least one host reference (hostUserId, hostWorkforceId or hostName) is required.',
    statusCode: 400,
  });
}

/** The host workforce profile is not usable for this Building's Client. */
export function hostConfirmationHostWorkforceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOST_CONFIRMATION_HOST_WORKFORCE_MISMATCH,
    message:
      'The host workforce profile does not belong to the same client as the building.',
    statusCode: 400,
  });
}

/** The host workforce profile exists but is INACTIVE. */
export function hostConfirmationHostWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOST_CONFIRMATION_HOST_WORKFORCE_INACTIVE,
    message: 'Inactive workforce profiles cannot host a confirmation.',
    statusCode: 400,
  });
}

/** The confirmation was already decided (confirmed or rejected). */
export function hostConfirmationAlreadyDecidedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HOST_CONFIRMATION_ALREADY_DECIDED,
    message:
      'This host confirmation has already been decided and cannot change.',
    statusCode: 409,
  });
}
