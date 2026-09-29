import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-12 PART 02 — bounded labor pricing basis errors. Every
 * failure is closed and typed; nothing resolves implicitly.
 */

export function handymanLaborPricingBasisNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_LABOR_PRICING_BASIS_NOT_FOUND,
    message: 'Handyman labor pricing basis definition not found.',
    statusCode: 404,
  });
}

export function handymanLaborPricingVersionNotDraftError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_LABOR_PRICING_VERSION_NOT_DRAFT,
    message:
      'Handyman labor pricing basis definitions may only be authored on a DRAFT agreement version.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanLaborPricingModeConflictError(
  agreementVersionId: string,
  mode: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_LABOR_PRICING_MODE_CONFLICT,
    message:
      'This agreement version already defines a labor pricing basis for the mode.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`, `mode=${mode}`],
  });
}

export function handymanLaborPricingKeyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_LABOR_PRICING_KEY_CONFLICT,
    message:
      'Idempotency key already used for a different Handyman labor pricing basis payload.',
    statusCode: 409,
  });
}

export function handymanLaborPricingBasisNotEffectiveError(
  mode: string,
  asOf: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_LABOR_PRICING_BASIS_NOT_EFFECTIVE,
    message:
      'No Handyman labor pricing basis definition for the mode is effective at the requested as-of instant (fail-closed; no implicit current).',
    statusCode: 409,
    details: [`mode=${mode}`, `asOf=${asOf}`],
  });
}

export function handymanLaborPricingValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_LABOR_PRICING_VALIDATION,
    message: 'Handyman labor pricing basis input validation failed.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
