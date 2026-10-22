import { AppError, ERROR_CODES } from '../../shared/errors';

export function workforceCertificationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_NOT_FOUND,
    message: 'Workforce certification record not found.',
    statusCode: 404,
  });
}

export function workforceCertificationAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_ALREADY_ACTIVE,
    message:
      'An active certification with this certificate number already exists for this workforce profile.',
    statusCode: 409,
  });
}

export function workforceCertificationClientMismatchError(
  message = 'Referenced entity belongs to a different client than the workforce profile.',
): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_CLIENT_MISMATCH,
    message,
    statusCode: 409,
  });
}

export function workforceCertificationStatusDateMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_STATUS_DATE_MISMATCH,
    message: 'Certification status is inconsistent with expiryDate.',
    statusCode: 400,
  });
}

export function workforceCertificationDocumentMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_DOCUMENT_MISMATCH,
    message:
      'Referenced document does not belong to the same client as the workforce profile.',
    statusCode: 409,
  });
}

export function workforceCertificationDocumentInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_DOCUMENT_INVALID,
    message: 'Referenced document does not exist or is inactive.',
    statusCode: 409,
  });
}

export function workforceCertificationInvalidFileReferenceError(
  message = 'fileReference must be a safe relative storage key or canonical hm-ev://<uuid> reference.',
): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_INVALID_FILE_REFERENCE,
    message,
    statusCode: 400,
  });
}

export function workforceCertificationVerificationActorRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_VERIFICATION_ACTOR_REQUIRED,
    message:
      'An authenticated verifier actor is required to mark a certification as VERIFIED or REJECTED.',
    statusCode: 400,
  });
}

export function workforceCertificationSelfVerificationForbiddenError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN,
    message:
      'Certificate owner is not allowed to verify or reject their own certification.',
    statusCode: 403,
  });
}

export function workforceCertificationForbiddenError(
  message = 'Actor is not authorized to access or manage this workforce certification.',
): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_FORBIDDEN,
    message,
    statusCode: 403,
  });
}
