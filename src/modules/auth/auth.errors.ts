import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * Generic invalid-credentials error. Unknown email and wrong password map to
 * the same error to avoid account enumeration.
 */
export function invalidCredentialsError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVALID_CREDENTIALS,
    message: 'Invalid email or password.',
    statusCode: 401,
  });
}

export function authenticationRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.AUTHENTICATION_REQUIRED,
    message: 'Authentication is required.',
    statusCode: 401,
  });
}

export function permissionDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_DENIED,
    message: 'You do not have permission to perform this action.',
    statusCode: 403,
  });
}

export function authRateLimitedError(): AppError {
  return new AppError({
    code: ERROR_CODES.AUTH_RATE_LIMITED,
    message: 'Too many login attempts. Please try again later.',
    statusCode: 429,
  });
}
