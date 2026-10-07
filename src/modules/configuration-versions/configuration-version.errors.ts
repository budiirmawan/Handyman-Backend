import { AppError, ERROR_CODES } from '../../shared/errors';

export function configurationVersionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFIGURATION_VERSION_NOT_FOUND,
    message: 'Configuration Version not found.',
    statusCode: 404,
  });
}

export function configurationLifecycleInvalidTransitionError(
  message = 'Configuration lifecycle transition is not allowed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.CONFIGURATION_LIFECYCLE_INVALID_TRANSITION,
    message,
    statusCode: 409,
  });
}

export function configurationValidationFailedError(errors: unknown[]): AppError {
  return new AppError({
    code: ERROR_CODES.CONFIGURATION_VALIDATION_FAILED,
    message: 'Configuration validation failed.',
    statusCode: 422,
    details: errors,
  });
}
