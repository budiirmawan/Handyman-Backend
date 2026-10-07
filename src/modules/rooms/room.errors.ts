import { AppError, ERROR_CODES } from '../../shared/errors';

export function roomNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROOM_NOT_FOUND,
    message: 'Room not found.',
    statusCode: 404,
  });
}

export function roomCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROOM_CODE_ALREADY_EXISTS,
    message: 'A room with this code already exists for this area.',
    statusCode: 409,
  });
}

export function roomAreaInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.AREA_NOT_AVAILABLE,
    message: 'Inactive areas cannot host new rooms.',
    statusCode: 400,
  });
}
