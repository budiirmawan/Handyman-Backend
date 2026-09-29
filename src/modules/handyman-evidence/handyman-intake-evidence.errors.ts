import { AppError, ERROR_CODES } from '../../shared/errors';

/** CR-HM-02 PART 04 — Handyman request-intake evidence errors. */

export function handymanServiceRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_FOUND,
    message: 'Handyman service request not found.',
    statusCode: 404,
  });
}

export function handymanIntakeEvidenceNotIntakeError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_INTAKE,
    message:
      'Intake evidence can only be recorded while the request is in INTAKE state.',
    statusCode: 400,
  });
}
