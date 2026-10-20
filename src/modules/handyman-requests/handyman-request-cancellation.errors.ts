import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-18 REQUEST-CANCEL-01 — bounded cancellation error vocabulary.
 *
 * Three distinct 409s so a consumer can render the right message without
 * parsing English:
 *   - NOT_ALLOWED  — the request is in a state that can never be cancelled
 *                    (terminal REFERRED),
 *   - ALREADY_CANCELLED — the request already carries a cancellation fact
 *                    (a different idempotency key cannot cancel twice),
 *   - COMMITTED    — the request owns an execution scope, i.e. a quotation
 *                    was approved; cancellation is refused and the
 *                    post-commitment authorities (scope close / variations)
 *                    own the ending.
 */
export function handymanRequestCancelNotAllowedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_CANCEL_NOT_ALLOWED,
    message:
      'This Handyman request cannot be cancelled from its current state.',
    statusCode: 409,
  });
}

export function handymanRequestAlreadyCancelledError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_ALREADY_CANCELLED,
    message: 'This Handyman request is already cancelled.',
    statusCode: 409,
  });
}

export function handymanRequestCancelCommittedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_CANCEL_COMMITTED,
    message:
      'This Handyman request is commercially committed (an execution scope ' +
      'exists) and cannot be cancelled; use the execution-scope lifecycle.',
    statusCode: 409,
  });
}
