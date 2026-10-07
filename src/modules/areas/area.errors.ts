import { AppError, ERROR_CODES } from '../../shared/errors';

export function areaNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.AREA_NOT_FOUND,
    message: 'Area not found.',
    statusCode: 404,
  });
}

export function areaCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.AREA_CODE_ALREADY_EXISTS,
    message: 'An area with this code already exists for this floor.',
    statusCode: 409,
  });
}

export function areaFloorInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.FLOOR_NOT_AVAILABLE,
    message: 'Inactive floors cannot host new areas.',
    statusCode: 400,
  });
}
