import { AppError, ERROR_CODES } from '../../shared/errors';

export function brandingConfigurationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.BRANDING_CONFIGURATION_NOT_FOUND,
    message: 'Branding Configuration not found.',
    statusCode: 404,
  });
}
