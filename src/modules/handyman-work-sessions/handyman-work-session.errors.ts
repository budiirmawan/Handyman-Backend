import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-08 PART 01 — persistence-boundary errors ONLY. No command,
 * gate, eligibility, or decision errors exist at this boundary (no
 * commands exist in this PART).
 */
export function handymanWorkSessionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_NOT_FOUND,
    message: 'Handyman work session not found.',
    statusCode: 404,
  });
}

/**
 * At most one ACTIVE (non-CHECKED_OUT) session per execution scope
 * (governance §11) — the one-active partial unique index backstop.
 */
export function handymanWorkSessionActiveConflictError(
  executionScopeId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_ACTIVE_CONFLICT,
    message:
      'An active Handyman work session already exists for this execution scope.',
    statusCode: 409,
    details: [`executionScopeId=${executionScopeId}`],
  });
}
