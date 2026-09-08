import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const immediateActionNotFoundError = (): AppError =>
  error(
    ERROR_CODES.IMMEDIATE_ACTION_NOT_FOUND,
    'Immediate Action not found.',
    404,
  );

/**
 * The Incident exists but is CANCELLED, so it can accrue no new response.
 * Distinct from "not found" because the caller may legitimately read the
 * Incident — nothing is disclosed by explaining why the write was refused.
 */
export const immediateActionIncidentNotActiveError = (): AppError =>
  error(
    ERROR_CODES.IMMEDIATE_ACTION_INCIDENT_NOT_ACTIVE,
    'A CANCELLED Incident cannot receive new immediate actions.',
    400,
  );

export const immediateActionUpdateNotAllowedError = (
  message = 'This Immediate Action can no longer be updated.',
): AppError =>
  error(ERROR_CODES.IMMEDIATE_ACTION_UPDATE_NOT_ALLOWED, message, 400);

export const immediateActionInvalidTransitionError = (
  from: string,
  to: string,
): AppError =>
  error(
    ERROR_CODES.IMMEDIATE_ACTION_INVALID_TRANSITION,
    `Immediate Action status cannot move from ${from} to ${to}.`,
    400,
  );

/**
 * 409, not 400: completing an already-completed action is a state conflict,
 * not a malformed request. Clients can distinguish "retry is pointless" from
 * "fix your payload".
 */
export const immediateActionAlreadyCompletedError = (): AppError =>
  error(
    ERROR_CODES.IMMEDIATE_ACTION_ALREADY_COMPLETED,
    'This Immediate Action is already completed.',
    409,
  );

export const immediateActionResponsibleInvalidError = (): AppError =>
  error(
    ERROR_CODES.IMMEDIATE_ACTION_RESPONSIBLE_INVALID,
    'The responsible user must be an existing ACTIVE user with access to the Building.',
    400,
  );

export const immediateActionTakenAtInvalidError = (): AppError =>
  error(
    ERROR_CODES.IMMEDIATE_ACTION_TAKEN_AT_INVALID,
    'The action date/time cannot be in the future.',
    400,
  );
