import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const findingEscalationNotFoundError = (): AppError =>
  error(
    ERROR_CODES.FINDING_ESCALATION_NOT_FOUND,
    'Finding Escalation not found.',
    404,
  );

/**
 * 409, not 400: the request is well-formed and the caller is entitled to make
 * it — it conflicts with existing state. This mirrors how BE-09 and BE-21A
 * report duplicate numbers, so clients can treat "already exists" uniformly.
 */
export const findingEscalationAlreadyActiveError = (): AppError =>
  error(
    ERROR_CODES.FINDING_ESCALATION_ALREADY_ACTIVE,
    'This Finding already has an active escalation.',
    409,
  );

/** The Finding belongs to a different Client — a tenancy-isolation breach. */
export const findingEscalationClientMismatchError = (): AppError =>
  error(
    ERROR_CODES.FINDING_ESCALATION_CLIENT_MISMATCH,
    'The referenced Finding belongs to a different client.',
    400,
  );

export const findingEscalationBuildingMismatchError = (): AppError =>
  error(
    ERROR_CODES.FINDING_ESCALATION_BUILDING_MISMATCH,
    'The referenced Finding belongs to a different building.',
    400,
  );

/** CLOSED / CANCELLED Findings have nothing left to escalate. */
export const findingEscalationFindingNotEscalatableError = (
  status: string,
): AppError =>
  error(
    ERROR_CODES.FINDING_ESCALATION_FINDING_NOT_ESCALATABLE,
    `A Finding in state ${status} cannot be escalated.`,
    400,
  );

export const findingEscalationUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.FINDING_ESCALATION_UPDATE_NOT_ALLOWED,
    'A CANCELLED Incident can no longer be updated.',
    400,
  );
