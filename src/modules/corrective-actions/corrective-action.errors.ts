import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const correctiveActionNotFoundError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_NOT_FOUND,
    'Corrective Action not found.',
    404,
  );

/**
 * The Incident exists but is CANCELLED, so no new remedial work can be
 * proposed against it. Distinct from "not found" because the caller may
 * legitimately read the Incident — nothing is disclosed by saying why.
 */
export const correctiveActionIncidentNotActiveError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_INCIDENT_NOT_ACTIVE,
    'A CANCELLED Incident cannot receive new corrective actions.',
    400,
  );

export const correctiveActionUpdateNotAllowedError = (
  message = 'This Corrective Action can no longer be updated.',
): AppError =>
  error(ERROR_CODES.CORRECTIVE_ACTION_UPDATE_NOT_ALLOWED, message, 400);

export const correctiveActionInvalidTransitionError = (
  from: string,
  to: string,
): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_INVALID_TRANSITION,
    `Corrective Action status cannot move from ${from} to ${to}.`,
    400,
  );

/**
 * A refusal must be explainable after the fact, so the reason is mandatory
 * rather than an optional note.
 */
export const correctiveActionRejectionReasonRequiredError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_REJECTION_REASON_REQUIRED,
    'A rejection reason is required to reject a Corrective Action.',
    400,
  );

/**
 * BE-21I — a deadline was set on work that has already reached an outcome.
 *
 * Refused rather than accepted-and-ignored: a deadline on a COMPLETED,
 * REJECTED, or CANCELLED action would be meaningless, and worse, it would
 * retroactively change that action's derived MET/MISSED verdict.
 */
export const correctiveActionDueDateNotAllowedError = (
  message = 'A due date cannot be set on a Corrective Action that has already finished.',
): AppError =>
  error(ERROR_CODES.CORRECTIVE_ACTION_DUE_DATE_NOT_ALLOWED, message, 400);

/** BE-21I — the deadline itself is unusable (e.g. implausibly far out). */
export const correctiveActionDueDateInvalidError = (
  message = 'The due date is not valid.',
): AppError =>
  error(ERROR_CODES.CORRECTIVE_ACTION_DUE_DATE_INVALID, message, 400);
