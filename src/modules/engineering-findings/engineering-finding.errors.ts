import { AppError, ERROR_CODES } from '../../shared/errors';

export function engineeringFindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_FINDING_NOT_FOUND,
    message: 'Engineering finding not found.',
    statusCode: 404,
  });
}

export function engineeringFindingAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_FINDING_ALREADY_LINKED,
    message: 'The finding already has an engineering context.',
    statusCode: 409,
  });
}

export function engineeringFindingSourceAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_FINDING_SOURCE_ALREADY_LINKED,
    message: 'An engineering finding already exists for this source execution.',
    statusCode: 409,
  });
}

export function engineeringFindingBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_FINDING_BUILDING_MISMATCH,
    message: 'The source does not belong to the requested building context.',
    statusCode: 400,
  });
}

/**
 * The source exists but does not resolve to an Engineering-bound execution
 * (e.g. a plain BE-07 checklist/form instance with no Engineering binding,
 * or a Work Order outside any Engineering operation).
 */
export function engineeringFindingSourceNoBuildingError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_FINDING_SOURCE_NO_BUILDING,
    message: 'The source does not resolve to an engineering building context.',
    statusCode: 400,
  });
}

export function engineeringFindingAssetBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_FINDING_ASSET_BUILDING_MISMATCH,
    message: 'The asset does not belong to the requested building context.',
    statusCode: 400,
  });
}

export function engineeringFindingLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_FINDING_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the requested building context.',
    statusCode: 400,
  });
}
