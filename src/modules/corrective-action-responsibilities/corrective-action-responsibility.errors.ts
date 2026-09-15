import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const correctiveActionResponsibilityNotFoundError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_RESPONSIBILITY_NOT_FOUND,
    'No responsible person is assigned to this Corrective Action.',
    404,
  );

/**
 * The referenced Workforce Profile does not exist or is INACTIVE.
 *
 * One code covers both so the endpoint cannot be used to probe which profile
 * ids exist — a caller who may not read personnel data learns only that their
 * reference was unusable.
 */
export const correctiveActionResponsiblePersonInvalidError = (): AppError =>
  error(
    ERROR_CODES.CORRECTIVE_ACTION_RESPONSIBLE_PERSON_INVALID,
    'The responsible person must be an existing ACTIVE workforce profile.',
    400,
  );

/**
 * The profile belongs to a different Client than the Incident.
 *
 * Distinct from the Building mismatch below because the remedies differ:
 * a Client mismatch means the wrong person entirely, while a Building
 * mismatch means the right organization but no placement at that site.
 */
export const correctiveActionResponsiblePersonClientMismatchError =
  (): AppError =>
    error(
      ERROR_CODES.CORRECTIVE_ACTION_RESPONSIBLE_PERSON_CLIENT_MISMATCH,
      'The responsible person belongs to a different Client than the Incident.',
      400,
    );

export const correctiveActionResponsiblePersonBuildingMismatchError =
  (): AppError =>
    error(
      ERROR_CODES.CORRECTIVE_ACTION_RESPONSIBLE_PERSON_BUILDING_MISMATCH,
      'The responsible person is not assigned to the Building of this Incident.',
      400,
    );

export const correctiveActionResponsibilityNotAllowedError = (
  message = 'Responsibility cannot be changed for this Corrective Action.',
): AppError =>
  error(ERROR_CODES.CORRECTIVE_ACTION_RESPONSIBILITY_NOT_ALLOWED, message, 400);

/**
 * 409, not 400: an active assignment already exists, so this is a state
 * conflict. The caller should reassign rather than fix their payload.
 */
export const correctiveActionResponsibilityAlreadyAssignedError =
  (): AppError =>
    error(
      ERROR_CODES.CORRECTIVE_ACTION_RESPONSIBILITY_ALREADY_ASSIGNED,
      'This Corrective Action already has an active responsible person; reassign instead.',
      409,
    );
