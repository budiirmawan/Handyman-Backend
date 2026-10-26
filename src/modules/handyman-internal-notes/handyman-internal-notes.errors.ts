import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanInternalNoteForbiddenError(
  message = 'Caller is not authorized to access or create internal operational notes.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INTERNAL_NOTE_FORBIDDEN,
    message,
    statusCode: 403,
  });
}

export function handymanInternalNoteIdempotencyConflictError(
  message = 'idempotencyKey was already used with a different internal note payload or request.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INTERNAL_NOTE_IDEMPOTENCY_CONFLICT,
    message,
    statusCode: 409,
  });
}

export function handymanInternalNoteImmutableError(
  message = 'Internal notes are append-only and cannot be modified or deleted.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INTERNAL_NOTE_IMMUTABLE,
    message,
    statusCode: 409,
  });
}

export function handymanServiceRequestNotFoundForInternalNoteError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_FOUND,
    message: 'Handyman service request not found.',
    statusCode: 404,
  });
}
