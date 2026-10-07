import { AppError, ERROR_CODES } from '../../shared/errors';

/** The check-in row could not be located. */
export function visitCheckInNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_NOT_FOUND,
    message: 'Visit check-in not found.',
    statusCode: 404,
  });
}

/** Exactly one visit reference must be supplied. */
export function visitCheckInVisitReferenceRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_VISIT_REFERENCE_REQUIRED,
    message:
      'Exactly one of expectedVisitorId or walkInVisitId is required.',
    statusCode: 400,
  });
}

/** The referenced visit is cancelled. */
export function visitCheckInVisitCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_VISIT_CANCELLED,
    message: 'A cancelled visit cannot be checked in.',
    statusCode: 400,
  });
}

/** The visit's visitor identity is not valid for entry. */
export function visitCheckInVisitorNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_VISITOR_NOT_ACTIVE,
    message:
      'The visitor identity is not ACTIVE (blocked or inactive) and cannot be checked in.',
    statusCode: 400,
  });
}

/** The visit's host confirmation is still PENDING. */
export function visitCheckInConfirmationPendingError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_CONFIRMATION_PENDING,
    message:
      'The host confirmation for this visit is still pending. Confirm the visit before check-in.',
    statusCode: 409,
  });
}

/** The visit's host confirmation was REJECTED. */
export function visitCheckInConfirmationRejectedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_CONFIRMATION_REJECTED,
    message:
      'The host confirmation for this visit was rejected. A rejected visit cannot be checked in.',
    statusCode: 409,
  });
}

/** An active check-in already exists for this visit. */
export function visitCheckInAlreadyCheckedInError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_ALREADY_CHECKED_IN,
    message: 'An active check-in already exists for this visit.',
    statusCode: 409,
  });
}

/** The check-in timestamp is in the future. */
export function visitCheckInTimeInFutureError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_TIME_IN_FUTURE,
    message: 'checkedInAt cannot be in the future.',
    statusCode: 400,
  });
}

/** The check-in is already CANCELLED. */
export function visitCheckInAlreadyCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_IN_ALREADY_CANCELLED,
    message: 'A cancelled check-in can no longer be modified.',
    statusCode: 409,
  });
}

/** Check-out requires an actively CHECKED_IN row. */
export function visitCheckOutNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_OUT_NOT_ACTIVE,
    message:
      'Only an actively checked-in visit can be checked out. This record is not CHECKED_IN.',
    statusCode: 409,
  });
}

/** The visit was already checked out. */
export function visitCheckOutAlreadyCheckedOutError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_OUT_ALREADY_CHECKED_OUT,
    message: 'This visit has already been checked out.',
    statusCode: 409,
  });
}

/** The check-out timestamp is in the future. */
export function visitCheckOutTimeInFutureError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_OUT_TIME_IN_FUTURE,
    message: 'checkedOutAt cannot be in the future.',
    statusCode: 400,
  });
}

/** The check-out timestamp precedes the original check-in. */
export function visitCheckOutBeforeCheckInError(): AppError {
  return new AppError({
    code: ERROR_CODES.VISIT_CHECK_OUT_BEFORE_CHECK_IN,
    message: 'checkedOutAt cannot be earlier than the original check-in.',
    statusCode: 400,
  });
}
