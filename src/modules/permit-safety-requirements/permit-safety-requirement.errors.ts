import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const permitSafetyRequirementNotFoundError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_SAFETY_REQUIREMENT_NOT_FOUND,
    'Permit Safety Requirement not found.',
    404,
  );

export const permitSafetyRequirementAlreadyExistsError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_SAFETY_REQUIREMENT_ALREADY_EXISTS,
    'This Safety Requirement type already exists for the Application.',
    409,
  );

export const permitSafetyPermitInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_SAFETY_PERMIT_INVALID,
    'The Permit or Permit Application is invalid for Safety Requirements.',
    400,
  );

export const permitSafetyContextMismatchError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_SAFETY_CONTEXT_MISMATCH,
    'The Safety Requirement does not match the Permit Building or Work Type.',
    400,
  );

export const permitSafetyUpdateNotAllowedError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_SAFETY_UPDATE_NOT_ALLOWED,
    'Cancelled Applications cannot receive Safety Requirement changes.',
    400,
  );

export const permitSafetySharedControlInvalidError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_SAFETY_SHARED_CONTROL_INVALID,
    'The referenced shared Checklist or Evidence control is invalid for this Permit.',
    400,
  );

export const permitSafetyPrerequisiteNotMetError = (): AppError =>
  error(
    ERROR_CODES.PERMIT_SAFETY_PREREQUISITE_NOT_MET,
    'Checklist or Evidence prerequisites are not complete, so readiness cannot be READY.',
    400,
  );
