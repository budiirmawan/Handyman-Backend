import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-13 PART 01 — bounded transaction/charge-line errors ONLY. No
 * payment, allocation, refund, reversal, adjustment, entitlement,
 * settlement, or provider error exists at this boundary (those
 * authorities are not implemented in this PART and never live here).
 */

/** Unknown transaction (client-bounded: never fabricated). */
export function handymanCustomerTransactionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_TRANSACTION_NOT_FOUND,
    message: 'Handyman customer transaction not found.',
    statusCode: 404,
  });
}

/** Unknown execution scope (client-bounded: never fabricated). */
export function handymanCustomerTransactionScopeNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_TRANSACTION_SCOPE_NOT_FOUND,
    message: 'Handyman execution scope not found.',
    statusCode: 404,
  });
}

/** Actor holds no client access to the scope's client. */
export function handymanCustomerTransactionNotAuthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED,
    message:
      'Actor is not authorized for Handyman customer transaction ledger writes on this client.',
    statusCode: 403,
  });
}

/**
 * The governed basis is missing or inconsistent: no approved snapshot
 * line to charge from, currency drift inside the version, or a
 * quotation line that does not belong to the anchored approved
 * version. A charge without a governed basis is never posted (§4.3).
 */
export function handymanCustomerTransactionBasisInvalidError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_TRANSACTION_BASIS_INVALID,
    message: 'Invalid Handyman customer transaction ledger basis.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

/**
 * Bounded ledger conflict: a second transaction for the same execution
 * scope (I9), or a second charge line for the same quotation line
 * (one-post-per-line). Never a silent second row.
 */
export function handymanCustomerTransactionConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_TRANSACTION_CONFLICT,
    message: 'Handyman customer transaction ledger conflict.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

/** Bounded request-surface validation (no authority from caller). */
export function handymanCustomerTransactionValidationError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_TRANSACTION_VALIDATION,
    message: `Invalid Handyman customer transaction request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}
