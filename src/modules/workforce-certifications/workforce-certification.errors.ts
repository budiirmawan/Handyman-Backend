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

export function workforceCertificationForbiddenError(
  message = 'Actor is not authorized to access or manage this workforce certification.',
): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_FORBIDDEN,
    message,
    statusCode: 403,
  });
}

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 02 — separation of duties.
 *
 * Verification is an attestation about a worker's competence. The worker who
 * owns the certificate (and therefore every actor whose workforce profile is
 * the subject of the decision) may read the record but can never decide its
 * verification status, even when they happen to hold the verification
 * permission. Client isolation is proven separately by the caller, so this
 * guard only ever narrows authority.
 */
export function workforceCertificationSelfVerificationForbiddenError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN,
    message:
      'The owner of a workforce certification can never verify or reject their own certificate.',
    statusCode: 403,
  });
}

/**
 * An INACTIVE certificate, or one whose expiry date has already passed, can
 * never become VERIFIED. Expiry is evaluated against the current instant, so a
 * certificate that expires later cannot be "pre-verified" either: the decision
 * endpoint re-reads the stored record each time.
 */
export function workforceCertificationVerificationNotAllowedError(
  message = 'An inactive or expired certificate can never be marked VERIFIED.',
): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_CERTIFICATION_VERIFICATION_NOT_ALLOWED,
    message,
    statusCode: 409,
  });
}
