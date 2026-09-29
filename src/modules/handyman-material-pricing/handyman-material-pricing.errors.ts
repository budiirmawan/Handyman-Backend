import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-12 PART 03 — bounded material pricing basis errors. Every
 * failure is closed and typed; nothing resolves implicitly and no
 * composition ever re-authors upstream truth.
 */

export function handymanMaterialPricingBasisNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_PRICING_BASIS_NOT_FOUND,
    message: 'Handyman material pricing basis definition not found.',
    statusCode: 404,
  });
}

export function handymanMaterialPricingVersionNotDraftError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_PRICING_VERSION_NOT_DRAFT,
    message:
      'Handyman material pricing basis definitions may only be authored on a DRAFT agreement version.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanMaterialPricingAlreadyDefinedError(
  agreementVersionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_PRICING_ALREADY_DEFINED,
    message:
      'This agreement version already defines its single material pricing basis.',
    statusCode: 409,
    details: [`agreementVersionId=${agreementVersionId}`],
  });
}

export function handymanMaterialPricingKeyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_PRICING_KEY_CONFLICT,
    message:
      'Idempotency key already used for a different Handyman material pricing basis payload.',
    statusCode: 409,
  });
}

export function handymanMaterialPricingBasisNotEffectiveError(
  asOf: string,
): AppError {
  return new AppError({
    code:
      ERROR_CODES.HANDYMAN_MATERIAL_PRICING_BASIS_NOT_EFFECTIVE,
    message:
      'No Handyman material pricing basis definition is effective at the requested as-of instant (fail-closed; no implicit current).',
    statusCode: 409,
    details: [`asOf=${asOf}`],
  });
}

export function handymanMaterialPricingCompositionError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_PRICING_COMPOSITION_ERROR,
    message:
      'Handyman material pricing basis composition refuses: the read-only inputs are inconsistent (fail-closed; nothing is re-authored).',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanMaterialPricingValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_MATERIAL_PRICING_VALIDATION,
    message: 'Handyman material pricing basis input validation failed.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
