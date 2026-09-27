import { AppError } from '../../shared/errors';
import { ERROR_CODES } from '../../shared/errors';

/** Referenced scheduling-readiness row not found. */
export function handymanSchedulingReadinessNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SCHEDULING_READINESS_NOT_FOUND,
    message: 'Handyman scheduling readiness not found.',
    statusCode: 404,
  });
}

/** The request already carries an ACTIVE readiness row (race-safe 409). */
export function handymanSchedulingReadinessAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SCHEDULING_READINESS_ALREADY_EXISTS,
    message:
      'An ACTIVE scheduling readiness already exists for this request.',
    statusCode: 409,
  });
}

/** Supersede attempted on a non-ACTIVE readiness row. */
export function handymanSchedulingReadinessInvalidStatusError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SCHEDULING_READINESS_INVALID_STATUS,
    message: 'Only the ACTIVE scheduling readiness can be superseded.',
    statusCode: 400,
  });
}

/** Preferred window missing, unparseable, reversed or zero-length. */
export function handymanSchedulingReadinessWindowInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SCHEDULING_READINESS_WINDOW_INVALID,
    message:
      'preferredWindowStart/preferredWindowEnd are required and start must be strictly before end.',
    statusCode: 400,
  });
}

/** Authoritative building has no timezone — cannot derive one, never guess. */
export function handymanSchedulingReadinessTimezoneUnavailableError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SCHEDULING_READINESS_TIMEZONE_UNAVAILABLE,
    message:
      'The authoritative building has no timezone; scheduling readiness cannot derive one.',
    statusCode: 400,
  });
}

/** PART 04: optional change reason exceeds its bounded length. */
export function handymanSchedulingReadinessReasonInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SCHEDULING_READINESS_REASON_INVALID,
    message: 'changeReason must be at most 500 characters when provided.',
    statusCode: 400,
  });
}
