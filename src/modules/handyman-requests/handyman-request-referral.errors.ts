import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * Referral is only derivable from a SPECIALIST_REQUIRED or
 * OUT_OF_HANDYMAN_SCOPE diagnosis — GENERAL_HANDYMAN (or no diagnosis)
 * never qualifies.
 */
export function handymanReferralNotEligibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_REFERRAL_NOT_ELIGIBLE,
    message:
      'A referral can only be created from a SPECIALIST_REQUIRED or ' +
      'OUT_OF_HANDYMAN_SCOPE diagnosis.',
    statusCode: 400,
  });
}

/** The request already carries its referral record (race-safe 409). */
export function handymanServiceRequestAlreadyReferredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_ALREADY_REFERRED,
    message: 'This Handyman request already has a referral record.',
    statusCode: 409,
  });
}
