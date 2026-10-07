import { AppError, ERROR_CODES } from '../../shared/errors';

export function moduleConfigurationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.MODULE_CONFIGURATION_NOT_FOUND,
    message: 'Module configuration not found.',
    statusCode: 404,
  });
}

export function moduleConfigurationAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.MODULE_CONFIGURATION_ALREADY_EXISTS,
    message: 'This module is already configured for the selected scope.',
    statusCode: 409,
  });
}
