import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-SVC-01 PART 01 — Service Catalog errors.
 *
 * Errors are structured and stable; 409-class errors mark conflicts that are
 * safe to retry with a corrected request (code collision). Client/Building
 * isolation denials reuse the shared `buildingAccessDeniedError` from the
 * context-access module (not defined here).
 */

export function serviceCatalogNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_NOT_FOUND,
    message: 'Service catalog entry not found.',
    statusCode: 404,
  });
}

export function serviceCatalogCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_CODE_ALREADY_EXISTS,
    message: 'A service catalog entry with this code already exists for this client.',
    statusCode: 409,
  });
}

export function serviceCatalogClientInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_CLIENT_INVALID,
    message: 'The referenced Client was not found or is not active.',
    statusCode: 404,
  });
}

export function serviceCatalogCodeImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_CODE_IMMUTABLE,
    message: 'Service catalog code is immutable; create a new entry to change identity.',
    statusCode: 400,
  });
}

export function serviceCatalogNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_NOT_ACTIVE,
    message: 'Service catalog entry is not ACTIVE; deactivation is terminal.',
    statusCode: 409,
  });
}
