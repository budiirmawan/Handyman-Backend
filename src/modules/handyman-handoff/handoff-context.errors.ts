import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-01 PART 02 — Handoff context resolution errors.
 *
 * Non-enumerating by convention: unknown, foreign, inactive, or cross-client
 * references collapse into the same context-validation failures; the caller
 * cannot learn whether a foreign tenant/building/space exists.
 */

export function handoffContextInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_HANDOFF_CONTEXT_INVALID,
    message:
      'An active tenant company and tenant building context for this building are required.',
    statusCode: 400,
  });
}

export function handoffRequesterInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_HANDOFF_REQUESTER_INVALID,
    message: 'The customer must be an active PIC of the tenant company.',
    statusCode: 400,
  });
}

export function handoffSpaceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_HANDOFF_SPACE_MISMATCH,
    message:
      'The space must belong to this building and have an active relationship to the tenant.',
    statusCode: 400,
  });
}
