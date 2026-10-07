import { AppError, ERROR_CODES } from '../../shared/errors';

export function featureEntitlementConfigurationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.FEATURE_ENTITLEMENT_CONFIGURATION_NOT_FOUND,
    message: 'Feature entitlement configuration not found.',
    statusCode: 404,
  });
}

export function featureEntitlementConfigurationAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.FEATURE_ENTITLEMENT_CONFIGURATION_ALREADY_EXISTS,
    message: 'This feature is already configured for the Module and scope.',
    statusCode: 409,
  });
}
