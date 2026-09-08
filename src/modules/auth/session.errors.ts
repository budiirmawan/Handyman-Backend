import { AppError, ERROR_CODES } from '../../shared/errors';

export function invalidSessionError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVALID_SESSION,
    message: 'The session is not valid.',
    statusCode: 401,
  });
}

export function sessionExpiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.SESSION_EXPIRED,
    message: 'The session has expired.',
    statusCode: 401,
  });
}
