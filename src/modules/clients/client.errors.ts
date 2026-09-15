import { AppError, ERROR_CODES } from '../../shared/errors';

export function clientNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_NOT_FOUND,
    message: 'Client not found.',
    statusCode: 404,
  });
}

export function clientCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_CODE_ALREADY_EXISTS,
    message: 'A client with this code already exists.',
    statusCode: 409,
  });
}

export function clientInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_INACTIVE,
    message: 'Inactive clients cannot be used as operational context.',
    statusCode: 400,
  });
}
