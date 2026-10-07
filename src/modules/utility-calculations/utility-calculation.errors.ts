import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18I — Utility Calculation error contract. */

export function utilityCalculationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_NOT_FOUND,
    message: 'Utility calculation not found.',
    statusCode: 404,
  });
}

/**
 * The referenced consumption is unusable: unknown, or belonging to a Meter or
 * Building the calculation cannot legitimately be anchored to.
 */
export function utilityCalculationConsumptionInvalidError(
  message = 'The referenced consumption is not valid for this calculation.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_CONSUMPTION_INVALID,
    message,
    statusCode: 400,
  });
}

/**
 * A live (DRAFT or FINALIZED) calculation already exists for this
 * consumption. Producing a second one would leave two competing figures for
 * the same period; the caller must recalculate the existing result instead.
 */
export function utilityCalculationAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_ALREADY_EXISTS,
    message:
      'A calculation already exists for this consumption. Recalculate the existing result instead.',
    statusCode: 409,
  });
}

export function utilityCalculationBasisNotFoundError(
  message = 'Utility calculation basis not found.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_BASIS_NOT_FOUND,
    message,
    statusCode: 404,
  });
}

/**
 * The basis exists but cannot be applied: wrong Client, wrong utility type,
 * inactive, or its effective window does not cover the consumption period.
 * Applying it anyway would produce a number nobody could later justify.
 */
export function utilityCalculationBasisInvalidError(
  message = 'The calculation basis cannot be applied to this consumption.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_BASIS_INVALID,
    message,
    statusCode: 400,
  });
}

/** The requested period is reversed or zero-length. */
export function utilityCalculationPeriodInvalidError(
  message = 'The calculation period is invalid: the end must be later than the start.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_PERIOD_INVALID,
    message,
    statusCode: 400,
  });
}

/**
 * A FINALIZED result is terminal. It cannot be recalculated, re-finalized, or
 * superseded — a finalized figure that could silently change would be
 * worthless as a record.
 */
export function utilityCalculationAlreadyFinalizedError(
  message = 'This calculation is finalized and can no longer be changed.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_ALREADY_FINALIZED,
    message,
    statusCode: 409,
  });
}

/** A superseded result is historical and cannot be acted on. */
export function utilityCalculationNotRecalculableError(
  message = 'This calculation has already been superseded and cannot be recalculated.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_NOT_RECALCULABLE,
    message,
    statusCode: 409,
  });
}

/** The tenant context supplied contradicts the consumption's own context. */
export function utilityCalculationTenantMismatchError(
  message = 'The tenant context does not match the consumption being calculated.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_CALCULATION_TENANT_MISMATCH,
    message,
    statusCode: 400,
  });
}
