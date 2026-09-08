import { AppError, ERROR_CODES } from '../../shared/errors';

export function licenseNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.LICENSE_NOT_FOUND,
    message: 'License not found.',
    statusCode: 404,
  });
}

export function licenseAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.LICENSE_ALREADY_ACTIVE,
    message: 'This subscription already has an ACTIVE license.',
    statusCode: 409,
  });
}
