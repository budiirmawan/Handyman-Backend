/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — settings error vocabulary.
 *
 * Field rules answer through the shared VALIDATION_ERROR contract and
 * authorization through PERMISSION_DENIED / BUILDING_ACCESS_DENIED; only the
 * two states a caller cannot derive get codes, plus the prefix-namespace
 * conflict that protects issued-number uniqueness.
 */
import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanDocumentSettingsNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_SETTINGS_NOT_FOUND,
    message:
      'No active Handyman document settings are configured for this service provider, document type and language.',
    statusCode: 404,
  });
}

export function handymanDocumentSettingsVersionConflictError(
  currentVersion: number | null,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_SETTINGS_VERSION_CONFLICT,
    message:
      'The document settings changed since they were read; re-read the current version and retry.',
    statusCode: 409,
    details:
      currentVersion === null
        ? ['No settings exist for this document type and language yet; send expectedVersion null.']
        : [`The current settings version is ${currentVersion}.`],
  });
}

/** Another document type of this provider already owns that prefix. */
export function handymanDocumentSettingsPrefixConflictError(
  documentKind: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_SETTINGS_PREFIX_CONFLICT,
    message:
      'That document prefix is already the numbering namespace of another document type for this service provider.',
    statusCode: 409,
    details: [
      `Choose a prefix no other document type of this provider uses; ${documentKind} keeps its own namespace.`,
    ],
  });
}

export function handymanDocumentSettingsValidationError(
  details: { field: string; message: string }[],
): AppError {
  return AppError.validation('Request validation failed.', details);
}
