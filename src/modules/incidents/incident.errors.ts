import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const incidentNotFoundError = (): AppError =>
  error(ERROR_CODES.INCIDENT_NOT_FOUND, 'Incident not found.', 404);

export const incidentNumberAlreadyExistsError = (): AppError =>
  error(
    ERROR_CODES.INCIDENT_NUMBER_ALREADY_EXISTS,
    'Incident number already exists for the Client.',
    409,
  );

export const incidentBuildingInactiveError = (): AppError =>
  error(
    ERROR_CODES.INCIDENT_BUILDING_INACTIVE,
    'Incidents can only be reported against an ACTIVE Building.',
    400,
  );

export const incidentLocationMismatchError = (message: string): AppError =>
  error(ERROR_CODES.INCIDENT_LOCATION_MISMATCH, message, 400);

export const incidentLocationInactiveError = (): AppError =>
  error(
    ERROR_CODES.INCIDENT_LOCATION_INACTIVE,
    'The referenced location is not ACTIVE.',
    400,
  );

export const incidentUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.INCIDENT_UPDATE_NOT_ALLOWED,
    'Only a REPORTED Incident can be updated.',
    400,
  );

export const incidentCancelNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.INCIDENT_CANCEL_NOT_ALLOWED,
    'Only a REPORTED Incident can be cancelled.',
    400,
  );
