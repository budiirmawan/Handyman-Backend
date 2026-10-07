import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-15 PART 03 — bounded free-warranty-rework errors. No chargeable
 * vocabulary, no pricing/payment, no FM/SaaS.
 */

export function handymanServiceWarrantyReworkNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_FOUND,
    message: 'Handyman service warranty rework not found.',
    statusCode: 404,
  });
}

/**
 * Intake gate: free rework exists ONLY for an APPROVED claim on its
 * ORIGINAL warranty / execution scope (§4/§5).
 */
export function handymanServiceWarrantyReworkNotEligibleError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_ELIGIBLE,
    message:
      'Free Handyman service warranty rework exists ONLY for an APPROVED claim of the same client, service warranty and ORIGINAL execution scope.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanServiceWarrantyReworkConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_CONFLICT,
    message:
      'A free Handyman service warranty rework already exists for this claim.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanServiceWarrantyReworkIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_ILLEGAL_TRANSITION,
    message:
      'Illegal Handyman service warranty rework transition (frozen state machine).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

export function handymanServiceWarrantyReworkEvidenceRequiredError():
AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_EVIDENCE_REQUIRED,
    message:
      'Verifying a Handyman service warranty rework requires bound evidence of the rework.',
    statusCode: 400,
  });
}

export function handymanServiceWarrantyReworkEvidenceInvalidError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_EVIDENCE_INVALID,
    message:
      'Handyman service warranty rework verification evidence must belong to the same client and ORIGINAL execution scope as the rework.',
    statusCode: 400,
    details: [`reason=${reason}`],
  });
}

export function handymanServiceWarrantyReworkQcInvalidError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_QC_INVALID,
    message:
      'Handyman service warranty rework verification may only consume a PASSED QC run of the same client and ORIGINAL execution scope.',
    statusCode: 400,
    details: [`reason=${reason}`],
  });
}

export function handymanServiceWarrantyReworkNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_NOT_AUTHORIZED,
    message:
      'Actor has no client access for this Handyman service warranty rework.',
    statusCode: 403,
  });
}

export function handymanServiceWarrantyReworkValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_REWORK_VALIDATION,
    message: 'Invalid Handyman service warranty rework input.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
