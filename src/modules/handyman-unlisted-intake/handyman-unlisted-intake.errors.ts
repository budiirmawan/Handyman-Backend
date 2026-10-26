import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanUnlistedIntakeCaseNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_CASE_NOT_FOUND,
    message: 'Handyman unlisted service intake case not found.',
    statusCode: 404,
  });
}

export function handymanUnlistedIntakeForbiddenError(
  message = 'You are not authorized to access this unlisted service intake case.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_FORBIDDEN,
    message,
    statusCode: 403,
  });
}

export function handymanUnlistedIntakeIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_IDEMPOTENCY_CONFLICT,
    message:
      'Idempotency key has already been used with a different unlisted service intake payload.',
    statusCode: 409,
  });
}

export function handymanUnlistedIntakeImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_UNLISTED_INTAKE_IMMUTABLE,
    message: 'Unlisted service intake case provenance and fields are immutable.',
    statusCode: 409,
  });
}
