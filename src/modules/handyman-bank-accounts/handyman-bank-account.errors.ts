import { AppError, ERROR_CODES } from '../../shared/errors';

export function handymanBankAccountNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_ACCOUNT_NOT_FOUND,
    message: 'Handyman bank account not found.',
    statusCode: 404,
  });
}

export function handymanBankAccountConflictError(reason: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_ACCOUNT_CONFLICT,
    message: 'Handyman bank account conflict.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

export function handymanBankAccountInvalidError(field: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_ACCOUNT_INVALID,
    message: `Invalid Handyman bank account request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}

export function handymanBankAccountNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_BANK_ACCOUNT_NOT_AUTHORIZED,
    message: 'Handyman bank account not authorized for this scope.',
    statusCode: 403,
  });
}
