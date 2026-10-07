import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-02G — Data isolation access errors.
 *
 * A controlled 403 indicates the authenticated User has no explicit active
 * assignment to the requested Building context. We intentionally do not reveal
 * whether the Building exists, to avoid leaking existence of inaccessible
 * scoped resources.
 */
export function buildingAccessDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_ACCESS_DENIED,
    message: 'Access to the requested building context is denied.',
    statusCode: 403,
  });
}

export function buildingContextRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_CONTEXT_REQUIRED,
    message: 'A building context is required for this request.',
    statusCode: 400,
  });
}

export function invalidBuildingContextError(): AppError {
  return new AppError({
    code: ERROR_CODES.INVALID_BUILDING_CONTEXT,
    message: 'The provided building context is invalid.',
    statusCode: 400,
  });
}
