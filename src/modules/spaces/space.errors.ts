import { AppError, ERROR_CODES } from '../../shared/errors';

export function spaceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SPACE_NOT_FOUND,
    message: 'Space not found.',
    statusCode: 404,
  });
}

export function spaceCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SPACE_CODE_ALREADY_EXISTS,
    message: 'A space with this code already exists for this room.',
    statusCode: 409,
  });
}

export function spaceRoomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROOM_NOT_AVAILABLE,
    message: 'Inactive rooms cannot host new spaces.',
    statusCode: 400,
  });
}
