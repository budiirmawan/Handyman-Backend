import { AppError, ERROR_CODES } from '../../shared/errors';

/** The visitor invitation row could not be located. */
export function visitorInvitationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_NOT_FOUND,
    message: 'Visitor invitation not found.',
    statusCode: 404,
  });
}

/** The referenced visitor belongs to a different Client. */
export function visitorInvitationVisitorClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_VISITOR_CLIENT_MISMATCH,
    message: 'The visitor does not belong to the same client as the building.',
    statusCode: 400,
  });
}

/** The referenced visitor is BLOCKED and cannot be invited. */
export function visitorInvitationVisitorBlockedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_VISITOR_BLOCKED,
    message: 'Blocked visitors cannot be invited.',
    statusCode: 400,
  });
}

/** The referenced visitor is INACTIVE and cannot be invited. */
export function visitorInvitationVisitorInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_VISITOR_INACTIVE,
    message: 'Inactive visitors cannot be invited.',
    statusCode: 400,
  });
}

/** No host reference (user / workforce / name) was supplied. */
export function visitorInvitationHostRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_HOST_REQUIRED,
    message:
      'At least one host reference (hostUserId, hostWorkforceId or hostName) is required.',
    statusCode: 400,
  });
}

/** The host workforce profile is not usable for this Building's Client. */
export function visitorInvitationHostWorkforceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_HOST_WORKFORCE_MISMATCH,
    message:
      'The host workforce profile does not belong to the same client as the building.',
    statusCode: 400,
  });
}

/** The host workforce profile exists but is INACTIVE. */
export function visitorInvitationHostWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_HOST_WORKFORCE_INACTIVE,
    message: 'Inactive workforce profiles cannot host a visitor invitation.',
    statusCode: 400,
  });
}

/** The expected departure is not after the expected arrival. */
export function visitorInvitationInvalidTimeWindowError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_INVALID_TIME_WINDOW,
    message: 'expectedDepartureAt must be after expectedArrivalAt.',
    statusCode: 400,
  });
}

/** The invitation is CANCELLED and can no longer change. */
export function visitorInvitationAlreadyCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISITOR_INVITATION_ALREADY_CANCELLED,
    message: 'A cancelled visitor invitation can no longer be modified.',
    statusCode: 409,
  });
}
