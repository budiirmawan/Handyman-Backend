import { AppError, ERROR_CODES } from '../../shared/errors';

export function moduleNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.MODULE_NOT_FOUND,
    message: 'Module not found.',
    statusCode: 404,
  });
}

export function moduleCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.MODULE_CODE_ALREADY_EXISTS,
    message: 'A module with this code already exists.',
    statusCode: 409,
  });
}

export function moduleInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.MODULE_INACTIVE,
    message: 'Inactive modules cannot be entitled.',
    statusCode: 400,
  });
}
