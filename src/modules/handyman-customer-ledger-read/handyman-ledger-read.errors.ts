import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-13 PART 06 — bounded read-contract errors.
 *
 * The read family introduces NO new authority and NO new error code:
 * a bad read request is the ledger's own bounded validation error, a
 * missing ledger is the ledger's own not-found error, and a caller
 * without client access is the ledger's own 403 (§9.6). There is no
 * error surface here that could imply a mutation or a settlement.
 */

/** Malformed read input (uuid/window/limit) — fail-closed, no reads. */
export function handymanLedgerReadInvalidError(field: string): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CUSTOMER_TRANSACTION_VALIDATION,
    message: `Invalid Handyman ledger read request (${field}).`,
    statusCode: 400,
    details: [`field=${field}`],
  });
}
