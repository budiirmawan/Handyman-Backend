import { AppError, ERROR_CODES } from '../../shared/errors';

export function frontDeskLogNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.FRONT_DESK_LOG_NOT_FOUND,
    message: 'Front Desk Log activity not found.',
    statusCode: 404,
  });
}

export function frontDeskLogInvalidDateRangeError(): AppError {
  return new AppError({
    code: ERROR_CODES.FRONT_DESK_LOG_INVALID_DATE_RANGE,
    message: 'occurredFrom must not be later than occurredTo.',
    statusCode: 400,
  });
}
