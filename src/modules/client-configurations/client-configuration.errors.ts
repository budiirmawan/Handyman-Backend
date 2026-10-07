import { AppError, ERROR_CODES } from '../../shared/errors';

export function clientConfigurationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_CONFIGURATION_NOT_FOUND,
    message: 'Client configuration not found.',
    statusCode: 404,
  });
}

export function clientConfigurationKeyAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.CLIENT_CONFIGURATION_KEY_ALREADY_EXISTS,
    message: 'This configuration key already exists for the client.',
    statusCode: 409,
  });
}
