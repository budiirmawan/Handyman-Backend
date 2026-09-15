import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

/**
 * Closure was refused because readiness is not met.
 *
 * The message carries the FIRST blocker so the caller learns the actual
 * reason rather than a generic refusal; the full list is available from the
 * closure-status endpoint, which reads the same rules.
 */
export const incidentClosureNotAllowedError = (
  message = 'This Incident cannot be closed yet.',
): AppError =>
  error(ERROR_CODES.INCIDENT_CLOSURE_NOT_ALLOWED, message, 400);

/**
 * A second attempt to close an already-CLOSED Incident.
 *
 * 409 rather than 400: the request is well-formed, but it conflicts with a
 * closure already on record. Distinguishing it from the generic refusal is
 * what tells a caller "this is done" instead of "try again later" — and
 * CLOSED is terminal, so trying again will never help.
 */
export const incidentAlreadyClosedError = (
  message = 'This Incident is already CLOSED; closure is final.',
): AppError => error(ERROR_CODES.INCIDENT_ALREADY_CLOSED, message, 409);
