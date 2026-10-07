import { AppError, ERROR_CODES } from '../../shared/errors';

/** The walk-in visit row could not be located. */
export function walkInVisitNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_NOT_FOUND,
    message: 'Walk-in visit not found.',
    statusCode: 404,
  });
}

/** Exactly one of visitorId / newVisitor must be supplied. */
export function walkInVisitVisitorReferenceRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_VISITOR_REFERENCE_REQUIRED,
    message:
      'Exactly one of visitorId (existing identity) or newVisitor (inline registration) is required.',
    statusCode: 400,
  });
}

/** The referenced visitor belongs to a different Client. */
export function walkInVisitVisitorClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_VISITOR_CLIENT_MISMATCH,
    message: 'The visitor does not belong to the same client as the building.',
    statusCode: 400,
  });
}

/** The referenced visitor is BLOCKED. */
export function walkInVisitVisitorBlockedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_VISITOR_BLOCKED,
    message: 'Blocked visitors cannot be registered at the front desk.',
    statusCode: 400,
  });
}

/** The referenced visitor is INACTIVE. */
export function walkInVisitVisitorInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_VISITOR_INACTIVE,
    message: 'Inactive visitors cannot be registered at the front desk.',
    statusCode: 400,
  });
}

/** An open guest-book entry already exists for this visitor in this Building. */
export function walkInVisitAlreadyRegisteredError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_ALREADY_REGISTERED,
    message:
      'An open walk-in entry already exists for this visitor in this building.',
    statusCode: 409,
  });
}

/** The host workforce profile is not usable for this Building's Client. */
export function walkInVisitHostWorkforceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_HOST_WORKFORCE_MISMATCH,
    message:
      'The host workforce profile does not belong to the same client as the building.',
    statusCode: 400,
  });
}

/** The host workforce profile exists but is INACTIVE. */
export function walkInVisitHostWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_HOST_WORKFORCE_INACTIVE,
    message: 'Inactive workforce profiles cannot host a walk-in visit.',
    statusCode: 400,
  });
}

/** The arrival timestamp is in the future. */
export function walkInVisitArrivalInFutureError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_ARRIVAL_IN_FUTURE,
    message: 'arrivedAt cannot be in the future.',
    statusCode: 400,
  });
}

/** The walk-in visit is CANCELLED and can no longer change. */
export function walkInVisitAlreadyCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.WALK_IN_VISIT_ALREADY_CANCELLED,
    message: 'A cancelled walk-in visit can no longer be modified.',
    statusCode: 409,
  });
}
