import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const permitNotFoundError = (): AppError =>
  error(ERROR_CODES.PERMIT_NOT_FOUND, 'Permit not found.', 404);

export const permitNumberAlreadyExistsError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_NUMBER_ALREADY_EXISTS,
    'Permit number already exists for the Client.',
    409,
  );

export const permitContractorInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_CONTRACTOR_INVALID,
    'The contractor context is invalid or inactive.',
    400,
  );

export const permitContextMismatchError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_CONTEXT_MISMATCH,
    'The Permit, Building, Client, and contractor contexts do not match.',
    400,
  );

export const permitUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_UPDATE_NOT_ALLOWED,
    'Only a DRAFT Permit can be updated.',
    400,
  );

export const permitCancelNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_CANCEL_NOT_ALLOWED,
    'Only a DRAFT Permit can be cancelled.',
    400,
  );
