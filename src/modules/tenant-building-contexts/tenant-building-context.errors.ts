import { AppError, ERROR_CODES } from '../../shared/errors';

export function tenantBuildingContextNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_BUILDING_CONTEXT_NOT_FOUND,
    message: 'Tenant building context not found.',
    statusCode: 404,
  });
}

export function tenantBuildingContextAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_BUILDING_CONTEXT_ALREADY_ACTIVE,
    message: 'The tenant company already has an active context in this building.',
    statusCode: 409,
  });
}

export function tenantBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_BUILDING_CLIENT_MISMATCH,
    message: 'The tenant company and building must belong to the same client context.',
    statusCode: 400,
  });
}

export function tenantBuildingSpaceRelationshipRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_BUILDING_SPACE_RELATIONSHIP_REQUIRED,
    message: 'An active tenant space relationship in the building is required.',
    statusCode: 400,
  });
}

export function tenantBuildingContextUnavailableError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_BUILDING_CONTEXT_UNAVAILABLE,
    message: 'Only active tenant companies and buildings can receive an active context.',
    statusCode: 400,
  });
}
