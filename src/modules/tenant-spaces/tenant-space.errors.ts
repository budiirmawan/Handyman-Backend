import { AppError, ERROR_CODES } from '../../shared/errors';

export function tenantSpaceRelationshipNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SPACE_RELATIONSHIP_NOT_FOUND,
    message: 'Tenant space relationship not found.',
    statusCode: 404,
  });
}

export function tenantSpaceAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SPACE_ALREADY_ASSIGNED,
    message: 'The space already has an active tenant relationship.',
    statusCode: 409,
  });
}

export function tenantSpaceClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SPACE_CLIENT_MISMATCH,
    message: 'The tenant company and space must belong to the same client context.',
    statusCode: 400,
  });
}

export function tenantSpaceBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SPACE_BUILDING_MISMATCH,
    message: 'The space does not belong to the supplied building.',
    statusCode: 400,
  });
}

export function tenantSpaceUnavailableError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SPACE_UNAVAILABLE,
    message: 'Only active tenant companies, buildings, and spaces can receive an active relationship.',
    statusCode: 400,
  });
}
