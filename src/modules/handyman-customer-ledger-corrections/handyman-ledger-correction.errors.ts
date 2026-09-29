import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-13 PART 05 — bounded correction errors ONLY. Unknown scope /
 * missing client access reuse the CR-HM-13 ledger's own codes (same CR,
 * same boundary). No entitlement, settlement, provider, or gateway
 * error exists at this boundary — those authorities are not implemented
 * in this PART and never live here.
 */

/** Unknown correction, or an unknown/foreign correction source. */
export function handymanLedgerCorrectionNotFoundError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_LEDGER_CORRECTION_NOT_FOUND,
    message: 'Handyman ledger correction not found.',
    statusCode: 404,
    details: [`reason=${reason}`],
  });
}

/**
 * Bounded correction conflict: refund beyond what was received and
 * applied (§7.2), reversing a fact twice (a fact may be reversed at
 * most once), reversing a payment whose allocations are still live,
 * a reversal amount that does not negate its source exactly, an
 * adjustment beyond its bound, a cross-transaction/cross-currency
 * source, or a replayed key bound to a different correction intent.
 */
export function handymanLedgerCorrectionConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_LEDGER_CORRECTION_CONFLICT,
    message: 'Handyman ledger correction conflict.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}

/** Bounded correction-surface validation (no authority from caller). */
export function handymanLedgerCorrectionInvalidError(
  field: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_LEDGER_CORRECTION_INVALID,
    message: `Invalid Handyman ledger correction request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}
