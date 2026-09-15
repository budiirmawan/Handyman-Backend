import { AppError, ERROR_CODES } from '../../shared/errors';

export function functionalLocationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.FUNCTIONAL_LOCATION_NOT_FOUND,
    message: 'Functional location not found.',
    statusCode: 404,
  });
}

export function functionalLocationCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.FUNCTIONAL_LOCATION_CODE_ALREADY_EXISTS,
    message:
      'A functional location with this code already exists for this building.',
    statusCode: 409,
  });
}

export function functionalLocationSpaceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.FUNCTIONAL_LOCATION_SPACE_MISMATCH,
    message: 'The referenced space does not belong to this building.',
    statusCode: 400,
  });
}

export function functionalLocationBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
    message: 'Inactive buildings cannot host new functional locations.',
    statusCode: 400,
  });
}
