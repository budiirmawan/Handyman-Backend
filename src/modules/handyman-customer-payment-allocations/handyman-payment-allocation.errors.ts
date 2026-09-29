import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-13 PART 04 — bounded allocation errors ONLY. Unknown scope /
 * missing client access reuse the CR-HM-13 ledger's own codes (same CR,
 * same boundary). No refund, reversal, adjustment, entitlement,
 * settlement, or provider error exists at this boundary — those
 * authorities are not implemented in this PART and never live here.
 */

/** Unknown allocation inside the caller's client boundary. */
export function handymanPaymentAllocationNotFoundError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_PAYMENT_ALLOCATION_NOT_FOUND,
    message: 'Handyman payment allocation not found.',
    statusCode: 404,
    details: [`reason=${reason}`],
  });
}

/**
 * Bounded allocation conflict: over-allocation of a payment (§6.2) or
 * of a charge line (§6.3), allocation of a payment that is not
 * CONFIRMED received funds (§5.3), a foreign payment/charge line, a
 * replayed idempotency key bound to a different allocation, or a
 * currency/kind law violation. Never a silent clamp or a merge.
 */
export function handymanPaymentAllocationConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_PAYMENT_ALLOCATION_CONFLICT,
    message: 'Handyman payment allocation conflict.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

/** Bounded allocation-surface validation (no authority from caller). */
export function handymanPaymentAllocationInvalidError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_PAYMENT_ALLOCATION_INVALID,
    message: `Invalid Handyman payment allocation request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}
