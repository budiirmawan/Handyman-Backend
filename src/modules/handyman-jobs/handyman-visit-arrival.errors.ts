import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-BE-06 RUN 1 — Handyman visit arrival errors.
 *
 * Rules owned by other authorities keep THEIR errors: visit/job/schedule
 * guards reuse the BE-05 HANDYMAN_SERVICE_VISIT_* / HANDYMAN_JOB_* codes,
 * provider/vendor/crew/worker chain failures reuse the CR-HM-BE-02/04,
 * BE-06 and BE-03C errors, and staff access failures reuse the BE-02G
 * context-access error. These factories cover only the arrival-attempt
 * rules this module owns. A FAILED verification is NOT an error: it is a
 * recorded attempt row with a server-owned failure reason.
 */

export function handymanVisitArrivalIdempotencyKeyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_ARRIVAL_IDEMPOTENCY_KEY_REQUIRED,
    message: 'idempotencyKey is required to record a visit arrival.',
    statusCode: 400,
  });
}

/** Same client + same idempotency key, materially different command facts. */
export function handymanVisitArrivalIdempotencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_ARRIVAL_IDEMPOTENCY_CONFLICT,
    message:
      'This idempotency key was already used for a different arrival command.',
    statusCode: 409,
  });
}

/**
 * The authenticated field actor does not resolve through the governed lead
 * chain (user → BE-03C workforce profile → ACTIVE vendor workforce binding
 * → ACTIVE crew membership → LEAD_WORKER of the visit's composition). IDs
 * only in the message — never worker PII.
 */
export function handymanVisitArrivalActorNotLeadError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_ARRIVAL_ACTOR_NOT_LEAD,
    message:
      'The authenticated user does not resolve to the lead worker of this visit crew.',
    statusCode: 403,
  });
}

export function handymanVisitArrivalAssistedReasonRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_ARRIVAL_ASSISTED_REASON_REQUIRED,
    message: 'assistedReason is required and must be a non-empty string.',
    statusCode: 400,
  });
}

/** Malformed command evidence (e.g. an unparseable occurredAt claim). */
export function handymanVisitArrivalEvidenceInvalidError(
  message = 'The arrival evidence input is invalid.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_ARRIVAL_EVIDENCE_INVALID,
    message,
    statusCode: 400,
  });
}

/**
 * In-transaction state drift backstop (e.g. the one-VERIFIED-per-visit
 * partial unique index rejected a concurrent insert that the visit-row lock
 * should have serialized). The command must be retried; state is never
 * guessed.
 */
export function handymanVisitArrivalStateInvalidError(
  message = 'The handyman visit arrival state changed during this operation.',
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_VISIT_ARRIVAL_STATE_INVALID,
    message,
    statusCode: 409,
  });
}
