import { AppError, ERROR_CODES } from '../../shared/errors';

/** Correct module-local notFound for the decision chain (same code as PART 04). */
export function handymanServiceRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_FOUND,
    message: 'Handyman service request not found.',
    statusCode: 404,
  });
}

/** The request already carries its F2 triage decision record (race-safe 409). */
export function handymanServiceRequestAlreadyTriagedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_ALREADY_TRIAGED,
    message: 'This Handyman request already has a triage decision record.',
    statusCode: 409,
  });
}

/** FROZEN F1: a triage decision may begin only from the INTAKE state. */
export function handymanServiceRequestNotIntakeError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_INTAKE,
    message:
      'A triage decision can only be recorded while the request is in INTAKE state.',
    statusCode: 400,
  });
}
