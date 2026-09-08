import { AppError, ERROR_CODES } from '../../shared/errors';

export function roomTypeNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROOM_TYPE_NOT_FOUND,
    message: 'Room type not found.',
    statusCode: 404,
  });
}

export function roomTypeCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROOM_TYPE_CODE_ALREADY_EXISTS,
    message: 'A room type with this code already exists for this client.',
    statusCode: 409,
  });
}

export function roomTypeInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROOM_TYPE_INACTIVE,
    message: 'Inactive room types cannot be assigned to rooms.',
    statusCode: 400,
  });
}

export function roomTypeClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROOM_TYPE_CLIENT_MISMATCH,
    message: 'Room and room type must belong to the same client.',
    statusCode: 400,
  });
}
