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

/** Target session is terminal and cannot accept a new command (§5). */
export function handymanWorkSessionStaleConflictError(
  sessionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_STALE_CONFLICT,
    message: 'Handyman work session is no longer commandable.',
    statusCode: 409,
    details: [`sessionId=${sessionId}`],
  });
}

/** CHECK_IN target: scope exists but is not AUTHORIZED (CR-HM-06). */
export function handymanWorkSessionScopeNotEligibleError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_SCOPE_NOT_ELIGIBLE,
    message:
      'Handyman execution scope is not authorized for field execution.',
    statusCode: 409,
  });
}

/**
 * CHECK_IN gate: the latest immutable CR-HM-07 result must be fresh,
 * VERIFIED, and bound to the exact scope, current assignment and Lead.
 */
export function handymanWorkSessionArrivalRequiredError(
  executionScopeId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_ARRIVAL_REQUIRED,
    message:
      'A fresh VERIFIED arrival for the current assignment and Lead '
      + 'is required before field work check-in.',
    statusCode: 409,
    details: [`executionScopeId=${executionScopeId}`],
  });
}

/** Actor is NOT the CURRENT authoritative assigned Crew Lead (§4). */
export function handymanWorkSessionNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_NOT_AUTHORIZED,
    message:
      'Only the current authoritative assigned Crew Lead may act on the Handyman work session.',
    statusCode: 403,
  });
}

/** Frozen state-machine violation (governance §5). */
export function handymanWorkSessionIllegalTransitionError(
  from: string,
  action: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_ILLEGAL_TRANSITION,
    message:
      'Illegal Handyman work session transition (frozen state machine).',
    statusCode: 409,
    details: [`from=${from}`, `action=${action}`],
  });
}

/** Bounded request-surface validation (no authority from caller). */
export function handymanWorkSessionValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.VALIDATION_ERROR,
    message: `Invalid Handyman work session request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}
