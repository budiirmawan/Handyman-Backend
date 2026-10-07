import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-15 PART 02 — bounded service-warranty CLAIM errors. No rework,
 * no pricing/payment, no FM/SaaS vocabulary.
 */

export function handymanServiceWarrantyClaimNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_FOUND,
    message: 'Handyman service warranty claim not found.',
    statusCode: 404,
  });
}

/**
 * Intake eligibility gate: only an existing service warranty in `ACTIVE`
 * state on the claim's ORIGINAL execution scope may receive a claim (§4).
 */
export function handymanServiceWarrantyClaimNotEligibleError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_ELIGIBLE,
    message:
      'A Handyman service warranty claim may only be opened on an ACTIVE service warranty of the same client and ORIGINAL execution scope.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanServiceWarrantyClaimConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_CONFLICT,
    message:
      'A non-terminal Handyman service warranty claim already exists for this warranty.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanServiceWarrantyClaimIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_ILLEGAL_TRANSITION,
    message:
      'Illegal Handyman service warranty claim transition (frozen state machine).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

export function handymanServiceWarrantyClaimEvidenceRequiredError():
AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_EVIDENCE_REQUIRED,
    message:
      'Submitting a Handyman service warranty claim requires bound evidence of the claim.',
    statusCode: 400,
  });
}

export function handymanServiceWarrantyClaimEvidenceInvalidError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_EVIDENCE_INVALID,
    message:
      'Handyman service warranty claim evidence must belong to the same client and ORIGINAL execution scope as the claim.',
    statusCode: 400,
    details: [`reason=${reason}`],
  });
}

export function handymanServiceWarrantyClaimNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_NOT_AUTHORIZED,
    message:
      'Actor has no client access for this Handyman service warranty claim.',
    statusCode: 403,
  });
}

export function handymanServiceWarrantyClaimValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_WARRANTY_CLAIM_VALIDATION,
    message: 'Invalid Handyman service warranty claim input.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
