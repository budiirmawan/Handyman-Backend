import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-13 PART 03 — bounded payment errors ONLY. Unknown transaction
 * / missing client access / unknown basis reuse the CR-HM-13 ledger's
 * own codes (same CR, same boundary). No allocation, refund,
 * reversal, adjustment, entitlement, settlement, or provider error
 * exists at this boundary — those authorities are not implemented in
 * this PART and never live here.
 */

/** Unknown payment within the caller's client boundary. */
export function handymanCustomerPaymentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_PAYMENT_NOT_FOUND,
    message: 'Handyman customer payment not found.',
    statusCode: 404,
  });
}

/**
 * Bounded payment conflict: a duplicate external reference on the
 * same transaction (§5.5 fail-closed convergence), a second decision
 * on an already-decided payment (one authoritative transition per
 * fact), or a payment recorded against a transaction that was never
 * opened.
 */
export function handymanCustomerPaymentConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_PAYMENT_CONFLICT,
    message: 'Handyman customer payment conflict.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

/** Bounded payment-surface validation (no authority from caller). */
export function handymanCustomerPaymentInvalidError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_PAYMENT_INVALID,
    message: `Invalid Handyman customer payment request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}
