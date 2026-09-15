import { AppError, ERROR_CODES } from '../../shared/errors';

export function reportArchiveNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.NOT_FOUND,
    message: 'Report archive not found.',
    statusCode: 404,
  });
}

export function reportArchiveIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.REPORT_ARCHIVE_IDEMPOTENCY_CONFLICT,
    message: 'The export idempotency key was already used with a different request.',
    statusCode: 409,
  });
}
