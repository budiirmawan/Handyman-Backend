import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-FIN-DOCUMENTS-01 — bounded payment-proof read errors ONLY.
 *
 * The read door reuses the CR-HM-13 denial vocabulary for its authority
 * wall (scope 404 → exact-Building 403 → payment 404) and adds exactly
 * two bounded codes for the proof artifact itself. Every proof-side
 * denial is fail-closed and uniform: a REMOVED proof, a proof bound to
 * another payment, a foreign/Field Evidence row, or a wrong evidence
 * kind are indistinguishable from an absent proof — never a data leak.
 */

/**
 * No valid ACTIVE HANDYMAN_CUSTOMER_PAYMENT proof is bound to the exact
 * authorized payment (absent, REMOVED, purged, wrong parent, or wrong
 * evidence kind — all uniformly 404).
 */
export function handymanPaymentProofNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PAYMENT_PROOF_NOT_FOUND,
    message: 'Handyman customer payment proof not found.',
    statusCode: 404,
  });
}

/**
 * The stored bytes contradict the authoritative upload-time integrity
 * metadata (missing, wrong size, or checksum mismatch): the corrupt
 * content is NEVER served. Bounded 409 — the evidence fact and its
 * stored object disagree, which is a data conflict for humans to act on.
 */
export function handymanPaymentProofIntegrityConflictError(
  reason: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PAYMENT_PROOF_INTEGRITY_CONFLICT,
    message: 'Handyman customer payment proof integrity conflict.',
    statusCode: 409,
    details: [`reason=${reason}`],
  });
}
