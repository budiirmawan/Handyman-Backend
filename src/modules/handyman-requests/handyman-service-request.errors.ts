import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-02 PART 03 — Handyman request intake errors.
 *
 * 409 codes mark safe-to-retry conflicts (one request per attribution;
 * inactive catalogue reference). 400 scope mismatch covers any attempt to
 * attach catalogue references outside the attribution's authoritative
 * Client scope.
 */

export function handymanServiceRequestAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_ALREADY_EXISTS,
    message:
      'A Handyman service request already exists for this channel attribution.',
    statusCode: 409,
  });
}

export function handymanServiceRequestScopeMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_SCOPE_MISMATCH,
    message:
      'The selected service or variant must belong to the channel attribution client and the selected service.',
    statusCode: 400,
  });
}

export { handymanServiceRequestNotFoundError } from './handyman-request-triage.errors';
