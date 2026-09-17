import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-06 RUN 2 — Handyman work session errors.
 *
 * Rules owned by other authorities keep THEIR errors: visit/job/schedule
 * guards reuse the BE-05 HANDYMAN_SERVICE_VISIT_* / HANDYMAN_JOB_* codes,
 * composition/crew/provider/vendor drift reuses the BE-05 stale-context
 * errors, and the vendor_work / work_order transitions stay owned by
 * BE-15B / BE-08C (their transition errors propagate unchanged from the
 * seam). These factories cover only the session rules this module owns.
 */

export function handymanWorkSessionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_NOT_FOUND,
    message: 'Handyman work session not found.',
    statusCode: 404,
  });
}

export function handymanWorkSessionIdempotencyKeyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_IDEMPOTENCY_KEY_REQUIRED,
    message: 'idempotencyKey is required to start a handyman work session.',
    statusCode: 400,
  });
}

/** Malformed command evidence (e.g. an unparseable occurredAt claim). */
export function handymanWorkSessionEvidenceInvalidError(
  message = 'The work session command evidence input is invalid.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_EVIDENCE_INVALID,
    message,
    statusCode: 400,
  });
}

/** Same client + same idempotency key, materially different command facts. */
export function handymanWorkSessionIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_IDEMPOTENCY_CONFLICT,
    message:
      'This idempotency key was already used for a different work session start command.',
    statusCode: 409,
  });
}

/**
 * The visit already carries an OPEN session started by ANOTHER actor. There
 * is never a second OPEN session per visit, and an open execution window is
 * never silently adopted by a different actor.
 */
export function handymanWorkSessionAlreadyOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_ALREADY_OPEN,
    message:
      'An open handyman work session started by another actor already exists for this visit.',
    statusCode: 409,
  });
}

/**
 * The authenticated actor does not resolve through the governed chain to
 * the authorized LEAD of the relevant crew (current composition crew for
 * START; start-context crew or current composition crew for END). IDs only
 * in messages — never worker PII. No hardcoded RBAC role names.
 */
export function handymanWorkSessionActorNotLeadError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_ACTOR_NOT_LEAD,
    message:
      'The authenticated user does not resolve to the authorized lead worker for this work session.',
    statusCode: 403,
  });
}

/** §3.F — no VERIFIED Run-1 arrival exists for the visit. */
export function handymanWorkSessionArrivalRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_ARRIVAL_REQUIRED,
    message:
      'A verified visit arrival is required before a work session can start.',
    statusCode: 409,
  });
}

/** §3.H — the frozen presence snapshot's LEAD row is not PRESENT. */
export function handymanWorkSessionLeadNotPresentError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_LEAD_NOT_PRESENT,
    message:
      'The lead worker of the frozen presence snapshot is not present at this visit.',
    statusCode: 409,
  });
}

/**
 * §3.I — the BE-05 execution readiness assessment (ONE semantic authority,
 * consumed through its factored core) returned ready=false. The message
 * lists the failed check NAMES only — booleans, never PII.
 */
export function handymanWorkSessionExecutionNotReadyError(
  failedChecks: string[],
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_EXECUTION_NOT_READY,
    message: `Execution readiness is not satisfied: ${failedChecks.join(', ') || 'unknown'}.`,
    statusCode: 409,
  });
}

/**
 * §3.J/K — the vendor work or work order is not in a legal execution-start
 * state (e.g. COMPLETED/CANCELLED/ON_HOLD drift). Lifecycle authority stays
 * with BE-15B / BE-08C; this error only refuses to start against an
 * illegal state.
 */
export function handymanWorkSessionExecutionStateInvalidError(
  message = 'The execution lifecycle state does not permit starting a work session.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_EXECUTION_STATE_INVALID,
    message,
    statusCode: 409,
  });
}

/**
 * §7 Case D — the work order claims IN_PROGRESS while its vendor work is
 * still NOT_STARTED: a split-brain execution state this module OWNS
 * detecting and refusing. It is NEVER silently normalized; remediation
 * belongs to the lifecycle owners.
 */
export function handymanWorkSessionExecutionStateInconsistentError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_EXECUTION_STATE_INCONSISTENT,
    message:
      'The work order is in progress while its vendor work has not started; the execution lifecycle state is inconsistent.',
    statusCode: 409,
  });
}

/** In-transaction drift backstop; the command must be retried. */
export function handymanWorkSessionStateInvalidError(
  message = 'The handyman work session state changed during this operation.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_WORK_SESSION_STATE_INVALID,
    message,
    statusCode: 409,
  });
}
