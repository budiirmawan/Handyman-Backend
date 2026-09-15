import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_NOT_FOUND,
    message: 'Handyman request not found.',
    statusCode: 404,
  });
}

export function handymanRequestNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_NUMBER_ALREADY_EXISTS,
    message: 'A handyman request with this number already exists for this client.',
    statusCode: 409,
  });
}

export function handymanRequestIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_IDEMPOTENCY_CONFLICT,
    message: 'The idempotency key was already used with a different handyman request payload.',
    statusCode: 409,
  });
}

export function handymanRequestAlreadyCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REQUEST_ALREADY_CANCELLED,
    message: 'Handyman request is already cancelled.',
    statusCode: 409,
  });
}
