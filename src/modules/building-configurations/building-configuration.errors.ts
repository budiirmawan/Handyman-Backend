import { AppError, ERROR_CODES } from '../../shared/errors';

export function buildingConfigurationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_CONFIGURATION_NOT_FOUND,
    message: 'Building configuration not found.',
    statusCode: 404,
  });
}

export function buildingConfigurationKeyAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_CONFIGURATION_KEY_ALREADY_EXISTS,
    message: 'This configuration key already exists for the building.',
    statusCode: 409,
  });
}
