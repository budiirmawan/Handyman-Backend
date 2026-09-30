import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-15 PART 01 — bounded service-warranty errors. No claim/rework,
 * no pricing/payment, no FM/SaaS vocabulary.
 */

export function handymanServiceWarrantyNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_NOT_FOUND,
    message: 'Handyman service warranty not found.',
    statusCode: 404,
  });
}

/**
 * The warranty start eligibility gate: only an ACCEPTED BAST for an
 * AUTHORIZED execution scope starts a service warranty (§5.1 / B1–B3).
 */
export function handymanServiceWarrantyNotEligibleError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_NOT_ELIGIBLE,
    message:
      'Handyman service warranty may start ONLY from an ACCEPTED BAST on an AUTHORIZED execution scope.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanServiceWarrantyActiveConflictError(
  executionScopeId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_ACTIVE_CONFLICT,
    message:
      'A Handyman service warranty already exists for this execution scope (one warranty per scope).',
    statusCode: 409,
    details: [`executionScopeId=${executionScopeId}`],
  });
}

export function handymanServiceWarrantyIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_ILLEGAL_TRANSITION,
    message:
      'Illegal Handyman service warranty transition (frozen state machine).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

export function handymanServiceWarrantyNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_NOT_AUTHORIZED,
    message:
      'Actor has no client access for this Handyman service warranty.',
    statusCode: 403,
  });
}

export function handymanServiceWarrantyValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_VALIDATION,
    message: 'Invalid Handyman service warranty input.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
