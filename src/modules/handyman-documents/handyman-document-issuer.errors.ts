/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — issuer profile error vocabulary.
 *
 * Only the two states this master data can answer that a caller cannot derive
 * from the generic vocabulary get their own code; field-level problems stay on
 * the shared VALIDATION_ERROR contract and authorization stays on the existing
 * BUILDING_ACCESS_DENIED / PERMISSION_DENIED answers.
 */
import { AppError, ERROR_CODES } from '../../shared/errors';

/** This provider Client has no ACTIVE issuer profile yet (fail-closed). */
export function handymanDocumentIssuerProfileNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_ISSUER_PROFILE_NOT_FOUND,
    message:
      'No active Handyman document issuer profile is configured for this service provider.',
    statusCode: 404,
  });
}

/** A stale writer tried to overwrite a profile it never read. */
export function handymanDocumentIssuerProfileVersionConflictError(
  currentVersion: number | null,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_ISSUER_PROFILE_VERSION_CONFLICT,
    message:
      'The issuer profile changed since it was read; re-read the current version and retry.',
    statusCode: 409,
    details:
      currentVersion === null
        ? ['No issuer profile exists for this provider yet; send expectedVersion null.']
        : [`The current issuer profile version is ${currentVersion}.`],
  });
}

export function handymanDocumentIssuerProfileValidationError(
  details: { field: string; message: string }[],
): AppError {
  return AppError.validation('Request validation failed.', details);
}
