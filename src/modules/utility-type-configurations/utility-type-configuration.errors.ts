import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18B — Electricity / Water / Gas configuration error contract. */

export function utilityTypeConfigurationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_TYPE_CONFIGURATION_NOT_FOUND,
    message: 'Utility type configuration not found.',
    statusCode: 404,
  });
}

export function utilityTypeConfigurationAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_TYPE_CONFIGURATION_ALREADY_EXISTS,
    message: 'This utility type is already configured for this client.',
    statusCode: 409,
  });
}

export function utilityTypeConfigurationInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_TYPE_CONFIGURATION_INACTIVE,
    message: 'Inactive utility type configurations cannot be used by a meter.',
    statusCode: 400,
  });
}

export function utilityTypeUomNotAllowedError(
  message = 'The unit of measure is not allowed for this utility type.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_TYPE_UOM_NOT_ALLOWED,
    message,
    statusCode: 400,
  });
}

export function utilityTypeUomAlreadyMappedError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_TYPE_UOM_ALREADY_MAPPED,
    message: 'This unit of measure is already mapped to the utility type.',
    statusCode: 409,
  });
}

export function utilityTypeUomMappingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_TYPE_UOM_MAPPING_NOT_FOUND,
    message: 'Allowed unit of measure mapping not found.',
    statusCode: 404,
  });
}
