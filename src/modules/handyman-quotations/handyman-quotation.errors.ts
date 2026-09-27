import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-06 PART 01 — Handyman quotation foundation errors.
 *
 * 409 codes mark safe-to-retry conflicts (one quotation thread per
 * request — add a revision instead). 400 codes mark authority/state
 * violations (missing/insufficient CR-HM-03 diagnosis scope).
 */

export function handymanQuotationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_NOT_FOUND,
    message: 'Handyman quotation not found.',
    statusCode: 404,
  });
}

export function handymanQuotationAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_ALREADY_EXISTS,
    message:
      'A Handyman quotation already exists for this request; create a revision instead.',
    statusCode: 409,
  });
}

export function handymanQuotationDiagnosisRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_DIAGNOSIS_REQUIRED,
    message:
      'Quotation preparation requires an existing diagnosis/scope record on the request.',
    statusCode: 400,
  });
}

export function handymanQuotationScopeInsufficientError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_SCOPE_INSUFFICIENT,
    message:
      'The diagnosis scope classification does not support quotation preparation.',
    statusCode: 400,
  });
}

export function handymanQuotationVersionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_VERSION_NOT_FOUND,
    message: 'Handyman quotation version not found.',
    statusCode: 404,
  });
}

export function handymanQuotationVersionNotDraftError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_VERSION_NOT_DRAFT,
    message:
      'Quotation lines may only be added to a DRAFT quotation version.',
    statusCode: 400,
  });
}

export function handymanQuotationLineInvalidError(
  message: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_LINE_INVALID,
    message,
    statusCode: 400,
  });
}

export function handymanQuotationCurrencyMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_QUOTATION_CURRENCY_MISMATCH,
    message:
      'All lines of one quotation version must share the same currency.',
    statusCode: 400,
  });
}
