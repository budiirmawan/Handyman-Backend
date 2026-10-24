import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Service Catalog Starter errors.
 *
 * Structured, stable codes. Client/Building isolation denials reuse the shared
 * `buildingAccessDeniedError` / `clientNotFoundError` / `clientInactiveError`
 * from the existing modules (not redefined here) so the denial vocabulary stays
 * identical across the catalogue surface.
 */

export function serviceCategoryNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATEGORY_NOT_FOUND,
    message: 'Service category not found.',
    statusCode: 404,
  });
}

export function serviceCategoryCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATEGORY_CODE_ALREADY_EXISTS,
    message: 'A service category with this code already exists for this client.',
    statusCode: 409,
  });
}

export function serviceCategoryClientInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATEGORY_CLIENT_INVALID,
    message: 'The referenced Client was not found or is not active.',
    statusCode: 404,
  });
}

export function serviceCategoryNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATEGORY_NOT_ACTIVE,
    message: 'Service category is not ACTIVE.',
    statusCode: 409,
  });
}

export function serviceCategoryInUseError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATEGORY_IN_USE,
    message:
      'Service category still has ACTIVE service items; deactivate or reassign them first.',
    statusCode: 409,
  });
}

export function serviceCatalogCategoryMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_CATEGORY_MISMATCH,
    message:
      'The supplied category does not match the governed service category.',
    statusCode: 400,
  });
}

export function serviceCatalogAvailabilityNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_AVAILABILITY_NOT_FOUND,
    message: 'Service catalog availability grant not found.',
    statusCode: 404,
  });
}

export function serviceCatalogAvailabilityAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_AVAILABILITY_ALREADY_EXISTS,
    message:
      'A service catalog availability grant already exists for this service and building.',
    statusCode: 409,
  });
}

export function serviceCatalogAvailabilityInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_AVAILABILITY_INVALID_STATE,
    message: 'Service catalog availability grant is not ACTIVE.',
    statusCode: 409,
  });
}

export function serviceCatalogAvailabilityBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_AVAILABILITY_BUILDING_MISMATCH,
    message: 'The building does not belong to the service catalog client.',
    statusCode: 400,
  });
}

export function starterPackClientInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.STARTER_PACK_CLIENT_INVALID,
    message: 'The starter pack can only be imported into an ACTIVE client.',
    statusCode: 404,
  });
}
