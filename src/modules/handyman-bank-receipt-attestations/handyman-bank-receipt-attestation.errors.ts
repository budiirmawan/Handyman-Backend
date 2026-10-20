import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanBankReceiptAttestationRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_RECEIPT_ATTESTATION_REQUIRED,
    message: 'Handyman bank receipt attestation is required to confirm payment.',
    statusCode: 400,
  });
}

export function handymanBankReceiptAttestationInvalidError(field: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_RECEIPT_ATTESTATION_INVALID,
    message: `Invalid Handyman bank receipt attestation (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}

export function handymanBankReceiptAttestationConflictError(reason: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_RECEIPT_ATTESTATION_CONFLICT,
    message: 'Handyman bank receipt attestation conflict.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanBankReceiptDuplicateReferenceError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_RECEIPT_DUPLICATE_REFERENCE,
    message: 'Handyman bank receipt duplicate bank transaction reference.',
    statusCode: 409,
  });
}

export function handymanBankReceiptAmountMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_RECEIPT_AMOUNT_MISMATCH,
    message: 'Handyman bank receipt credited amount does not match payment amount.',
    statusCode: 409,
  });
}
