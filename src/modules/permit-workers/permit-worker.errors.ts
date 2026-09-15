import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const permitWorkerNotFoundError = (): AppError =>
  error(ERROR_CODES.PERMIT_WORKER_NOT_FOUND, 'Permit Worker entry not found.', 404);

export const permitWorkerContextInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_CONTEXT_INVALID,
    'Permit Worker requires a matching Application, Building, and open validity.',
    400,
  );

export const permitWorkerContractorInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_CONTRACTOR_INVALID,
    'Permit Contractor context is invalid or inactive.',
    400,
  );

export const permitWorkerInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_INVALID,
    'Worker does not resolve to an existing external Workforce profile.',
    400,
  );

export const permitWorkerInactiveError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_INACTIVE,
    'Worker or Vendor Workforce relationship is inactive or ineffective.',
    400,
  );

export const permitWorkerContractorMismatchError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_CONTRACTOR_MISMATCH,
    'Worker does not belong to the Permit Contractor.',
    400,
  );

export const permitWorkerAlreadyActiveError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_ALREADY_ACTIVE,
    'Worker already has an ACTIVE entry on this Permit.',
    409,
  );

export const permitWorkerInvalidValidityError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_INVALID_VALIDITY,
    'Worker validity must be ordered and contained within Permit and Workforce validity.',
    400,
  );

export const permitWorkerUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_UPDATE_NOT_ALLOWED,
    'Only an ACTIVE Worker entry on an open Permit may be updated.',
    400,
  );

export const permitWorkerDeactivateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_WORKER_DEACTIVATE_NOT_ALLOWED,
    'Only an ACTIVE Worker entry may be deactivated.',
    400,
  );
