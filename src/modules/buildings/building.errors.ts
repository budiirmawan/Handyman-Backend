import { AppError, ERROR_CODES } from '../../shared/errors';

export function buildingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_FOUND,
    message: 'Building not found.',
    statusCode: 404,
  });
}

export function buildingCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_CODE_ALREADY_EXISTS,
    message: 'A building with this code already exists for this property.',
    statusCode: 409,
  });
}
