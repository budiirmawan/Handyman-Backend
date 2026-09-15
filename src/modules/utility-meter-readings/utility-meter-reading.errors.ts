import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18E — Meter Reading error contract. */

export function utilityMeterReadingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_NOT_FOUND,
    message: 'Meter reading not found.',
    statusCode: 404,
  });
}

/**
 * A reading already exists for this Meter at this instant. Readings are
 * append-only, so a repeated timestamp is treated as a duplicate submission
 * rather than silently replacing the posted reading.
 */
export function utilityMeterReadingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_ALREADY_EXISTS,
    message:
      'A reading already exists for this meter at this timestamp. Posted readings are never overwritten.',
    statusCode: 409,
  });
}

/** The submitted UOM does not match the Meter's configured unit. */
export function utilityMeterReadingUomMismatchError(
  message = 'The reading unit of measure must match the meter configuration.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_UOM_MISMATCH,
    message,
    statusCode: 400,
  });
}

/** The value is not a usable measurement (negative, non-finite, too precise). */
export function utilityMeterReadingValueInvalidError(
  message = 'The reading value is invalid.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_VALUE_INVALID,
    message,
    statusCode: 400,
  });
}

/** The supplied tenant context contradicts the Meter's BE-18D assignment. */
export function utilityMeterReadingTenantMismatchError(
  message = 'The tenant context does not match the meter assignment.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_TENANT_MISMATCH,
    message,
    statusCode: 400,
  });
}

/**
 * Attempted mutation of a posted reading. BE-18E is append-only: corrections
 * are recorded as a new reading so the original is never lost.
 */
export function utilityMeterReadingImmutableError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_METER_READING_IMMUTABLE,
    message:
      'Posted meter readings are immutable. Record a correcting reading instead.',
    statusCode: 409,
  });
}
