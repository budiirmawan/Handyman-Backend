import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const permitWorkContextNotFoundError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORK_CONTEXT_NOT_FOUND,
    'Permit work context not found.',
    404,
  );

export const permitWorkLocationInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORK_LOCATION_INVALID,
    'The selected work location does not exist or is inactive.',
    400,
  );

export const permitWorkLocationBuildingMismatchError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORK_LOCATION_BUILDING_MISMATCH,
    'The selected work location does not belong to the Permit Building.',
    400,
  );

export const permitWorkTypeInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORK_TYPE_INVALID,
    'workType must be a valid controlled data code.',
    400,
  );

export const permitWorkPlannedPeriodInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORK_PLANNED_PERIOD_INVALID,
    'The planned period must be in the future with end after start.',
    400,
  );

export const permitWorkContextUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORK_CONTEXT_UPDATE_NOT_ALLOWED,
    'Work context can be assigned or updated only while the Application is DRAFT.',
    400,
  );
