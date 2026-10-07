import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18G — Consumption error contract. */

export function utilityMeterConsumptionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_CONSUMPTION_NOT_FOUND,
    message: 'Meter consumption not found.',
    statusCode: 404,
  });
}

/**
 * This closing reading has already been consumed into a calculation.
 * Recalculating is idempotent rather than silently producing a second,
 * divergent figure for the same period.
 */
export function utilityMeterConsumptionAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_CONSUMPTION_ALREADY_EXISTS,
    message:
      'A consumption has already been calculated for this closing reading.',
    statusCode: 409,
  });
}

/**
 * A referenced reading is unusable: unknown, belonging to another meter, or
 * the same row supplied as both endpoints.
 */
export function utilityMeterConsumptionReadingInvalidError(
  message = 'The referenced meter readings are not valid for this calculation.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_CONSUMPTION_READING_INVALID,
    message,
    statusCode: 400,
  });
}

/** The period is reversed or zero-length. */
export function utilityMeterConsumptionPeriodInvalidError(
  message = 'The consumption period is invalid: the current reading must be later than the previous reading.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_CONSUMPTION_PERIOD_INVALID,
    message,
    statusCode: 400,
  });
}

/**
 * The delta is negative. A meter that appears to run backwards means a
 * rollover, a replacement, or a misread — all of which need an explicit
 * decision, so BE-18G refuses to store the figure silently.
 */
export function utilityMeterConsumptionNegativeError(
  message = 'Consumption would be negative: the current reading is lower than the previous reading. Resolve the underlying readings first.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_CONSUMPTION_NEGATIVE,
    message,
    statusCode: 400,
  });
}

/** The two readings disagree on unit, or contradict the meter configuration. */
export function utilityMeterConsumptionUomMismatchError(
  message = 'The readings must share the same unit of measure as the meter configuration.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_CONSUMPTION_UOM_MISMATCH,
    message,
    statusCode: 400,
  });
}

/** The two readings were taken under different tenant assignments. */
export function utilityMeterConsumptionTenantMismatchError(
  message = 'The readings span a change of tenant assignment.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_CONSUMPTION_TENANT_MISMATCH,
    message,
    statusCode: 400,
  });
}
