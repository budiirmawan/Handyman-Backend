import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const permitApplicationNotFoundError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPLICATION_NOT_FOUND,
    'Permit Application not found.',
    404,
  );

export const permitApplicationAlreadyExistsError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPLICATION_ALREADY_EXISTS,
    'A Permit Application already exists for this Permit.',
    409,
  );

export const permitApplicationPermitInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPLICATION_PERMIT_INVALID,
    'The referenced Permit does not exist or cannot receive an Application.',
    400,
  );

export const permitApplicationContractorInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPLICATION_CONTRACTOR_INVALID,
    'The Permit Contractor is not eligible for this Application.',
    400,
  );

export const permitApplicationInvalidWorkDateError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPLICATION_INVALID_WORK_DATE,
    'requestedWorkAt must be a future date and time.',
    400,
  );

export const permitApplicationUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPLICATION_UPDATE_NOT_ALLOWED,
    'Only a DRAFT Permit Application can be updated.',
    400,
  );

export const permitApplicationSubmitNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPLICATION_SUBMIT_NOT_ALLOWED,
    'Only a valid DRAFT Permit Application can be submitted.',
    400,
  );

export const permitApplicationCancelNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_APPLICATION_CANCEL_NOT_ALLOWED,
    'Only a DRAFT or SUBMITTED Permit Application can be cancelled.',
    400,
  );
