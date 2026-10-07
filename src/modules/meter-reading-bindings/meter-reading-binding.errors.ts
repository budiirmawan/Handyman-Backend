import { AppError, ERROR_CODES } from '../../shared/errors';

export function meterReadingBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.METER_READING_BINDING_NOT_FOUND,
    message: 'Meter reading binding not found.',
    statusCode: 404,
  });
}

export function meterReadingBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.METER_READING_BINDING_ALREADY_EXISTS,
    message: 'An active meter reading binding already exists for this asset and field.',
    statusCode: 409,
  });
}

export function meterReadingBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.METER_READING_BINDING_INACTIVE,
    message: 'Inactive meter reading bindings cannot start executions.',
    statusCode: 400,
  });
}

/**
 * The Form Field belongs to a different Client than the Asset. Reported as
 * 400 so the caller learns the combination is invalid without being told
 * anything about the other Client's forms.
 */
export function meterReadingFieldClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.METER_READING_FIELD_CLIENT_MISMATCH,
    message: 'The reading field does not belong to the asset client.',
    statusCode: 400,
  });
}

export function meterReadingUomClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.METER_READING_UOM_CLIENT_MISMATCH,
    message: 'The unit of measure does not belong to the asset client.',
    statusCode: 400,
  });
}

export function meterReadingUomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.METER_READING_UOM_INACTIVE,
    message: 'Inactive units of measure cannot be bound to meter readings.',
    statusCode: 400,
  });
}

export function meterReadingOutOfRangeError(
  value: number,
  minimumValue: number | null,
  maximumValue: number | null,
): AppError {
  const range =
    minimumValue !== null && maximumValue !== null
      ? `between ${minimumValue} and ${maximumValue}`
      : minimumValue !== null
        ? `at least ${minimumValue}`
        : `at most ${maximumValue as number}`;
  return new AppError({
    code: ERROR_CODES.METER_READING_OUT_OF_RANGE,
    message: `Reading ${value} is outside the configured range (${range}).`,
    statusCode: 400,
  });
}

export function meterReadingExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.METER_READING_EXECUTION_NOT_FOUND,
    message: 'Form instance is not linked to a meter reading execution.',
    statusCode: 404,
  });
}

export function meterReadingLocationBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.METER_READING_LOCATION_BUILDING_MISMATCH,
    message: 'The functional location does not belong to the asset building.',
    statusCode: 400,
  });
}
