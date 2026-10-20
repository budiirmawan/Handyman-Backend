import { AppError, ERROR_CODES } from '../../shared/errors';

export function tenantImportNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_IMPORT_NOT_FOUND,
    message: 'Tenant import batch not found.',
    statusCode: 404,
  });
}

export function tenantImportStateConflictError(
  message = 'Tenant import batch is not in a state that allows this action.',
): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_IMPORT_STATE_CONFLICT,
    message,
    statusCode: 409,
  });
}

export function tenantImportIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_IMPORT_IDEMPOTENCY_CONFLICT,
    message:
      'An import batch with this idempotencyKey already exists for this Client with different content.',
    statusCode: 409,
  });
}

export function tenantImportEmptyError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_IMPORT_EMPTY,
    message: 'An import batch must carry at least one row.',
    statusCode: 400,
  });
}
