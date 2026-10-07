import { AppError, ERROR_CODES } from '../../shared/errors';

/** The Lost & Found row could not be located. */
export function securityLostFoundNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_NOT_FOUND,
    message: 'Security lost & found record not found.',
    statusCode: 404,
  });
}

/** A Lost & Found record with the same (building, item_code) already exists. */
export function securityLostFoundItemCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_ITEM_CODE_ALREADY_EXISTS,
    message:
      'A security lost & found record with this item code already exists in the building.',
    statusCode: 409,
  });
}

/** The optional Security Post is in a different Building. */
export function securityLostFoundSecurityPostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_SECURITY_POST_BUILDING_MISMATCH,
    message:
      'The security post does not belong to the same building as the lost & found record.',
    statusCode: 400,
  });
}

/** The optional Functional Location is in a different Building. */
export function securityLostFoundFunctionalLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_FUNCTIONAL_LOCATION_BUILDING_MISMATCH,
    message:
      'The functional location does not belong to the same building as the lost & found record.',
    statusCode: 400,
  });
}

/** The requested transition is not allowed from the current custody state. */
export function securityLostFoundInvalidTransitionError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_INVALID_TRANSITION,
    message:
      'The requested action is not allowed from the current custody state.',
    statusCode: 400,
  });
}

/** The Lost & Found record is in a terminal state and cannot be modified. */
export function securityLostFoundTerminalError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_TERMINAL,
    message:
      'The lost & found record is in a terminal state and cannot be modified.',
    statusCode: 400,
  });
}

/** A return was attempted on a record that has no active claim. */
export function securityLostFoundNoActiveClaimError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_NO_ACTIVE_CLAIM,
    message:
      'The lost & found record has no active claim and cannot be returned.',
    statusCode: 400,
  });
}

/** An attempt to register a claim when the record is not eligible. */
export function securityLostFoundDuplicateActiveClaimError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_DUPLICATE_ACTIVE_CLAIM,
    message:
      'The lost & found record already has an active claim; register a new claim only after the current claim is closed.',
    statusCode: 409,
  });
}

/** A return was attempted in an invalid state (e.g. terminal). */
export function securityLostFoundReturnInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_RETURN_INVALID,
    message:
      'The lost & found record cannot be returned in its current state.',
    statusCode: 400,
  });
}

/** A list query supplied an invalid date range. */
export function securityLostFoundInvalidDateRangeError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_LOST_FOUND_INVALID_DATE_RANGE,
    message: 'The supplied date range is invalid (from must be ≤ to).',
    statusCode: 400,
  });
}
