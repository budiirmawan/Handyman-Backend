import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const operationalIncidentNotFoundError = (): AppError =>
  error(
    ERROR_CODES.OPERATIONAL_INCIDENT_NOT_FOUND,
    'Operational Incident not found.',
    404,
  );

/** The Incident exists but is ASSET_FAILURE / FINDING_ESCALATION. */
export const operationalIncidentTypeMismatchError = (): AppError =>
  error(
    ERROR_CODES.OPERATIONAL_INCIDENT_TYPE_MISMATCH,
    'The referenced Incident is not an OPERATIONAL Incident.',
    400,
  );

export const operationalIncidentReporterInvalidError = (): AppError =>
  error(
    ERROR_CODES.OPERATIONAL_INCIDENT_REPORTER_INVALID,
    'The reporter must be an existing ACTIVE user with access to the Building.',
    400,
  );

export const operationalIncidentUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.OPERATIONAL_INCIDENT_UPDATE_NOT_ALLOWED,
    'A CANCELLED Incident can no longer be updated.',
    400,
  );

export const operationalIncidentInvalidTransitionError = (
  from: string,
  to: string,
): AppError =>
  error(
    ERROR_CODES.OPERATIONAL_INCIDENT_INVALID_TRANSITION,
    `Operational status cannot move from ${from} to ${to}.`,
    400,
  );

export const operationalIncidentOccurrenceInvalidError = (): AppError =>
  error(
    ERROR_CODES.OPERATIONAL_INCIDENT_OCCURRENCE_INVALID,
    'The occurrence date/time cannot be in the future.',
    400,
  );

export const securityIncidentActiveShiftRequiredError = (): AppError =>
  error(
    ERROR_CODES.SECURITY_INCIDENT_ACTIVE_SHIFT_REQUIRED,
    'Security incident reporting requires an active current shift in the requested building.',
    409,
  );

export const securityIncidentShiftAmbiguousError = (): AppError =>
  error(
    ERROR_CODES.SECURITY_INCIDENT_SHIFT_AMBIGUOUS,
    'Multiple active current shift assignments match the reporting context; cannot determine reporting shift.',
    409,
  );

export const securityIncidentBuildingMismatchError = (): AppError =>
  error(
    ERROR_CODES.SECURITY_INCIDENT_BUILDING_MISMATCH,
    'The requested building does not match the reporting field context building.',
    409,
  );

export const securityIncidentReporterMismatchError = (): AppError =>
  error(
    ERROR_CODES.SECURITY_INCIDENT_REPORTER_MISMATCH,
    'Security incident reports cannot be filed using another reporter’s field context.',
    400,
  );
