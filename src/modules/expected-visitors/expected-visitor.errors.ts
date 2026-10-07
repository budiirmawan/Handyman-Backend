import { AppError, ERROR_CODES } from '../../shared/errors';

/** The expected visitor row could not be located. */
export function expectedVisitorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_NOT_FOUND,
    message: 'Expected visitor not found.',
    statusCode: 404,
  });
}

/** Without an invitation, buildingId / visitorId / arrival / purpose are required. */
export function expectedVisitorContextRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_CONTEXT_REQUIRED,
    message:
      'buildingId, visitorId, expectedArrivalAt and purpose are required when no invitation is referenced.',
    statusCode: 400,
  });
}

/** The referenced invitation is CANCELLED. */
export function expectedVisitorInvitationCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_INVITATION_CANCELLED,
    message: 'A cancelled invitation cannot back an expected visitor.',
    statusCode: 400,
  });
}

/** The supplied Building / Visitor conflicts with the referenced invitation. */
export function expectedVisitorInvitationMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_INVITATION_MISMATCH,
    message:
      'The supplied building or visitor does not match the referenced invitation.',
    statusCode: 400,
  });
}

/** A non-cancelled expected visitor already exists for this invitation. */
export function expectedVisitorInvitationAlreadyUsedError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_INVITATION_ALREADY_USED,
    message:
      'An active expected visitor already exists for this invitation.',
    statusCode: 409,
  });
}

/** The referenced visitor belongs to a different Client. */
export function expectedVisitorVisitorClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_VISITOR_CLIENT_MISMATCH,
    message: 'The visitor does not belong to the same client as the building.',
    statusCode: 400,
  });
}

/** The referenced visitor is BLOCKED. */
export function expectedVisitorVisitorBlockedError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_VISITOR_BLOCKED,
    message: 'Blocked visitors cannot be expected.',
    statusCode: 400,
  });
}

/** The referenced visitor is INACTIVE. */
export function expectedVisitorVisitorInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_VISITOR_INACTIVE,
    message: 'Inactive visitors cannot be expected.',
    statusCode: 400,
  });
}

/** No host reference (user / workforce / name) present. */
export function expectedVisitorHostRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_HOST_REQUIRED,
    message:
      'At least one host reference (hostUserId, hostWorkforceId or hostName) is required.',
    statusCode: 400,
  });
}

/** The host workforce profile is not usable for this Building's Client. */
export function expectedVisitorHostWorkforceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_HOST_WORKFORCE_MISMATCH,
    message:
      'The host workforce profile does not belong to the same client as the building.',
    statusCode: 400,
  });
}

/** The host workforce profile exists but is INACTIVE. */
export function expectedVisitorHostWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_HOST_WORKFORCE_INACTIVE,
    message: 'Inactive workforce profiles cannot host an expected visitor.',
    statusCode: 400,
  });
}

/** The expected departure is not after the expected arrival. */
export function expectedVisitorInvalidTimeWindowError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_INVALID_TIME_WINDOW,
    message: 'expectedDepartureAt must be after expectedArrivalAt.',
    statusCode: 400,
  });
}

/** The expected visitor is CANCELLED and can no longer change. */
export function expectedVisitorAlreadyCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.EXPECTED_VISITOR_ALREADY_CANCELLED,
    message: 'A cancelled expected visitor can no longer be modified.',
    statusCode: 409,
  });
}
