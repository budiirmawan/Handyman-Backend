import { AppError, ERROR_CODES } from '../../shared/errors';

/** The Key row could not be located. */
export function securityKeyNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_NOT_FOUND,
    message: 'Security key not found.',
    statusCode: 404,
  });
}

/** A Key with the same (building, code) already exists. */
export function securityKeyCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_CODE_ALREADY_EXISTS,
    message:
      'A security key with this code already exists in the building.',
    statusCode: 409,
  });
}

/** The Key's building does not match the supplied context. */
export function securityKeyBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_BUILDING_MISMATCH,
    message: 'The security key does not belong to the requested building.',
    statusCode: 400,
  });
}

/** The optional Security Post is in a different Building. */
export function securityKeySecurityPostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_SECURITY_POST_BUILDING_MISMATCH,
    message:
      'The security post does not belong to the same building as the key.',
    statusCode: 400,
  });
}

/** The optional Functional Location is in a different Building. */
export function securityKeyFunctionalLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_FUNCTIONAL_LOCATION_BUILDING_MISMATCH,
    message:
      'The functional location does not belong to the same building as the key.',
    statusCode: 400,
  });
}

/** The Key is not in a state that allows issue (e.g. INACTIVE). */
export function securityKeyNotAvailableError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_NOT_AVAILABLE,
    message:
      'The security key is not available for issue (must be AVAILABLE).',
    statusCode: 400,
  });
}

/** The Key is already ISSUED — duplicate issue rejected. */
export function securityKeyAlreadyIssuedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_ALREADY_ISSUED,
    message: 'The security key is already issued.',
    statusCode: 409,
  });
}

/** The Key is not currently ISSUED — return rejected. */
export function securityKeyNotIssuedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_NOT_ISSUED,
    message: 'The security key is not currently issued.',
    statusCode: 400,
  });
}

/** A return was attempted on a custody row that is not the active issue. */
export function securityKeyReturnInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_RETURN_INVALID,
    message:
      'The active custody row cannot be returned by the requested user.',
    statusCode: 400,
  });
}

/** LOST keys cannot be re-issued through the normal flow. */
export function securityKeyLostCannotBeIssuedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_LOST_CANNOT_BE_ISSUED,
    message: 'LOST keys cannot be issued through the normal flow.',
    statusCode: 400,
  });
}

/** The referenced custody row could not be located. */
export function securityKeyCustodyNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_CUSTODY_NOT_FOUND,
    message: 'Security key custody record not found.',
    statusCode: 404,
  });
}

/** The recipient Workforce is INACTIVE. */
export function securityKeyWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_WORKFORCE_INACTIVE,
    message: 'Inactive workforce profiles cannot receive a key.',
    statusCode: 400,
  });
}

/** The recipient Workforce has no active Building assignment. */
export function securityKeyWorkforceBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_KEY_WORKFORCE_BUILDING_MISMATCH,
    message:
      'The workforce has no active building assignment for this building.',
    statusCode: 400,
  });
}
