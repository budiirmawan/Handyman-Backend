/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — bank account error vocabulary.
 *
 * Field shape problems stay on the shared VALIDATION_ERROR contract and
 * authorization on the existing PERMISSION_DENIED / BUILDING_ACCESS_DENIED
 * answers; currency policy is answered by the platform monetary-context
 * contract. Only the states that are specific to a payment destination get
 * their own codes, and no message ever repeats a submitted account number.
 */
import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanDocumentBankAccountNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_BANK_ACCOUNT_NOT_FOUND,
    message:
      'No such Handyman document bank account for this service provider, or it is not readable at this version.',
    statusCode: 404,
  });
}

/** A stale writer tried to change or activate a version it never read. */
export function handymanDocumentBankAccountVersionConflictError(
  currentVersion: number | null,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_BANK_ACCOUNT_VERSION_CONFLICT,
    message:
      'The bank account changed since it was read; re-read the current version and retry.',
    statusCode: 409,
    details:
      currentVersion === null
        ? ['This bank account has no version to update; create it first.']
        : [`The current bank account version is ${currentVersion}.`],
  });
}

/** The transition the caller asked for is not one the lifecycle permits. */
export function handymanDocumentBankAccountStateConflictError(
  detail: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATE_CONFLICT,
    message: 'This bank account cannot be moved to that state from its current state.',
    statusCode: 409,
    details: [detail],
  });
}

/**
 * The confirmation the verification act demands was absent or did not match.
 * Deliberately a conflict, not a validation error: the caller's intent is
 * well-formed, the stored data simply is not confirmed yet.
 */
export function handymanDocumentBankAccountConfirmationRequiredError(
  detail: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONFIRMATION_REQUIRED,
    message: 'Explicit confirmation is required before this bank account can change state.',
    statusCode: 409,
    details: [detail],
  });
}

/** Another ACTIVE default already serves this provider and currency. */
export function handymanDocumentBankAccountDefaultTakenError(details: string[]): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_DOCUMENT_BANK_ACCOUNT_DEFAULT_TAKEN,
    message:
      'Another verified default receiving account already exists for this currency; authorize the replacement explicitly.',
    statusCode: 409,
    details,
  });
}

export function handymanDocumentBankAccountValidationError(
  details: { field: string; message: string }[],
): AppError {
  return AppError.validation('Request validation failed.', details);
}
