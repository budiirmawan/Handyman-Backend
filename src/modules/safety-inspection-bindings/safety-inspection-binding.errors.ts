import { AppError, ERROR_CODES } from '../../shared/errors';

export function safetyInspectionBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SAFETY_INSPECTION_BINDING_NOT_FOUND,
    message: 'Safety Inspection binding not found.',
    statusCode: 404,
  });
}

export function safetyInspectionBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SAFETY_INSPECTION_BINDING_ALREADY_EXISTS,
    message:
      'An ACTIVE Safety Inspection binding already exists for this schedule definition.',
    statusCode: 409,
  });
}

/**
 * A corrupted database must never be reduced to an arbitrary binding id. The
 * caller receives one bounded, machine-readable conflict instead.
 */
export function safetyInspectionBindingAmbiguousError(): AppError {
  return new AppError({
    code: ERROR_CODES.SAFETY_INSPECTION_BINDING_AMBIGUOUS,
    message:
      'Multiple ACTIVE Safety Inspection bindings exist for this schedule definition.',
    statusCode: 409,
  });
}
