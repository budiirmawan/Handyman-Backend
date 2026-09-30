import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-15 PART 04 — bounded chargeable-additional-work errors. No amount,
 * price, currency, ledger, payment or settlement vocabulary; no FM/SaaS.
 */

export function handymanChargeableAdditionalWorkNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_FOUND,
    message: 'Handyman chargeable additional work not found.',
    statusCode: 404,
  });
}

/**
 * Intake gate: chargeable additional work exists ONLY for an APPROVED or
 * REJECTED claim whose warranty head agrees (§4/§5).
 */
export function handymanChargeableAdditionalWorkNotEligibleError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_ELIGIBLE,
    message:
      'Handyman chargeable additional work exists ONLY for an APPROVED or REJECTED claim of the same client, service warranty and ORIGINAL execution scope.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanChargeableAdditionalWorkConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_CONFLICT,
    message:
      'A separated Handyman chargeable additional-work referral already exists for this claim.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

/**
 * BLOCKER B8: free warranty rework and chargeable additional work are
 * SEPARATE. A free rework that was accepted or executed can never be
 * converted into chargeable work, and once a chargeable referral exists
 * the free rework of that claim can never leave REWORK_DRAFT.
 */
export function handymanChargeableAdditionalWorkFreeReworkConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_FREE_REWORK_CONFLICT,
    message:
      'Free warranty rework and chargeable additional work are SEPARATE: a free rework that was accepted or executed can never be converted into chargeable work.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanChargeableAdditionalWorkIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ILLEGAL_TRANSITION,
    message:
      'Illegal Handyman chargeable additional-work transition (frozen state machine).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

export function handymanChargeableAdditionalWorkNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_NOT_AUTHORIZED,
    message:
      'Only the customer-side authority bound to the claim client may propose, accept or reject Handyman chargeable additional work.',
    statusCode: 403,
  });
}

export function handymanChargeableAdditionalWorkValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_VALIDATION,
    message: 'Invalid Handyman chargeable additional-work input.',
    statusCode: 400,
    details: [`field=${field}`],
  });
}
