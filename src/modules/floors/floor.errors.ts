import { AppError, ERROR_CODES } from '../../shared/errors';

export function floorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.FLOOR_NOT_FOUND,
    message: 'Floor not found.',
    statusCode: 404,
  });
}

export function floorCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.FLOOR_CODE_ALREADY_EXISTS,
    message: 'A floor with this code already exists for this building.',
    statusCode: 409,
  });
}

export function floorBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
    message: 'Inactive buildings cannot host new floors.',
    statusCode: 400,
  });
}
