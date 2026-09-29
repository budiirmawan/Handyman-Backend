import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-03 PART 02 — inspection-step errors. The module-canonical 404
 * (`handymanServiceRequestNotFoundError`) lives in
 * `handyman-request-triage.errors.ts` (PART 01) and is reused by the
 * service directly — no duplicate definition exists in this module.
 */

/** FROZEN F1: an inspection may begin only from INSPECTION_REQUIRED. */
export function handymanServiceRequestNotInspectionRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_INSPECTION_REQUIRED,
    message:
      'An inspection can only be recorded while the request is in INSPECTION_REQUIRED state.',
    statusCode: 400,
  });
}

/** The request already carries its inspection record (race-safe 409). */
export function handymanServiceRequestAlreadyInspectedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_ALREADY_INSPECTED,
    message: 'This Handyman request already has an inspection record.',
    statusCode: 409,
  });
}
