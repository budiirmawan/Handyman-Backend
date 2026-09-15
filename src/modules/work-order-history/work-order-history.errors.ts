import { AppError, ERROR_CODES } from '../../shared/errors';

export function workOrderHistoryInvalidFilterError(): AppError {
  return new AppError({
    code: ERROR_CODES.BAD_REQUEST,
    message: 'History filter range is invalid.',
    statusCode: 400,
  });
}
