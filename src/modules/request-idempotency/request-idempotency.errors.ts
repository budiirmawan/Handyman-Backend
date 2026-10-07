import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — error vocabulary.
 *
 * Generic:
 * - IDEMPOTENCY_KEY_REQUIRED (400)
 * - IDEMPOTENCY_CONFLICT (409)
 *
 * Do NOT add IDEMPOTENCY_REQUEST_IN_PROGRESS — atomic single-transaction
 * design ensures external caller never observes independently committed
 * IN_PROGRESS claim.
 *
 * Conflict must NOT leak stored response, fingerprint, or raw key.
 * Actor scoping prevents cross-user replay.
 * Operation scoping prevents cross-command replay.
 */

export function idempotencyKeyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    message: 'Idempotency-Key is required.',
    statusCode: 400,
  });
}

export function idempotencyConflictError(operationKey?: string): AppError {
  // OperationKey may be exposed if established convention permits; we include
  // it in message only when provided, but never expose stored response,
  // fingerprint, or raw key.
  const message = operationKey
    ? `The idempotency key was already used with a different request for operation ${operationKey}.`
    : 'The idempotency key was already used with a different request.';
  return new AppError({
    code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
    message,
    statusCode: 409,
  });
}
