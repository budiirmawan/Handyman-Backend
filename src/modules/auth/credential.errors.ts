import { AppError, ERROR_CODES } from '../../shared/errors';

export function credentialNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CREDENTIAL_NOT_FOUND,
    message: 'Credential not found.',
    statusCode: 404,
  });
}

export function credentialAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CREDENTIAL_ALREADY_EXISTS,
    message: 'A credential already exists for this user.',
    statusCode: 409,
  });
}

export function passwordPolicyViolationError(details: unknown[] = []): AppError {
  return new AppError({
    code: ERROR_CODES.PASSWORD_POLICY_VIOLATION,
    message: 'Password does not satisfy the password policy.',
    statusCode: 400,
    details,
  });
}

/**
 * Raised when a candidate password does not match the stored hash. Used by
 * login verification (BE-01C); defined here so the credential error surface
 * stays in one place.
 */
export function invalidPasswordError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVALID_PASSWORD,
    message: 'The provided password is incorrect.',
    statusCode: 401,
  });
}
