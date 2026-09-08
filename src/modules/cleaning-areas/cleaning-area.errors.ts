import { AppError, ERROR_CODES } from '../../shared/errors';

export function cleaningAreaNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_AREA_NOT_FOUND,
    message: 'Cleaning area not found.',
    statusCode: 404,
  });
}

export function cleaningAreaCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_AREA_CODE_ALREADY_EXISTS,
    message: 'A cleaning area with this code already exists for this building.',
    statusCode: 409,
  });
}

export function cleaningAreaInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_AREA_INACTIVE,
    message: 'Inactive cleaning area cannot be used for operational activity.',
    statusCode: 400,
  });
}

export function cleaningAreaLocationMismatchError(
  message = 'The referenced location does not belong to this building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_AREA_LOCATION_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function cleaningAreaBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLEANING_AREA_BUILDING_MISMATCH,
    message: 'The cleaning area belongs to a different building.',
    statusCode: 400,
  });
}

export function cleaningAreaBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
    message: 'Inactive buildings cannot host new cleaning areas.',
    statusCode: 400,
  });
}
