import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18A — Meter Master error contract. */

export function utilityMeterNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_NOT_FOUND,
    message: 'Meter not found.',
    statusCode: 404,
  });
}

/**
 * The Meter exists but is INACTIVE, so it cannot take part in an operation
 * that requires a live meter (e.g. an ACTIVE BE-18C hierarchy binding).
 */
export function utilityMeterInactiveError(
  message = 'Inactive meters cannot be used for this operation.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_INACTIVE,
    message,
    statusCode: 400,
  });
}

export function utilityMeterCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_CODE_ALREADY_EXISTS,
    message: 'A meter with this code already exists for this client.',
    statusCode: 409,
  });
}

export function utilityMeterUomNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_UOM_NOT_FOUND,
    message: 'Unit of measure not found.',
    statusCode: 404,
  });
}

export function utilityMeterUomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_UOM_INACTIVE,
    message: 'Inactive units of measure cannot be assigned to a meter.',
    statusCode: 400,
  });
}

export function utilityMeterUomClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_UOM_CLIENT_MISMATCH,
    message: 'The unit of measure belongs to a different client.',
    statusCode: 400,
  });
}

export function utilityMeterLocationMismatchError(
  message = 'The referenced location does not belong to this building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_LOCATION_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function utilityMeterBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
    message: 'Inactive buildings cannot host new meters.',
    statusCode: 400,
  });
}
