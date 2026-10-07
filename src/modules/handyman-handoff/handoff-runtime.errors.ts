import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-01 PART 03 — handoff runtime errors.
 *
 * Non-enumerating: unknown integration, inactive integration, bad
 * signature, malformed, stale, or expired assertions all collapse into one
 * unauthenticated failure. No secret material ever appears in a message.
 */

export function handoffAssertionInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_HANDOFF_ASSERTION_INVALID,
    message: 'Invalid or expired handoff assertion.',
    statusCode: 401,
  });
}

export function handoffAssertionReplayedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_HANDOFF_ASSERTION_REPLAYED,
    message: 'Handoff assertion has already been used.',
    statusCode: 409,
  });
}

export function handoffExchangeInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_HANDOFF_EXCHANGE_INVALID,
    message: 'Invalid or expired handoff exchange.',
    statusCode: 401,
  });
}
