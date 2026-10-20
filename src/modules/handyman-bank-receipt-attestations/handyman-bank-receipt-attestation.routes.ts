import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { isValidUuid } from '../clients';
import { AppError } from '../../shared/errors';
import { handymanBankReceiptAttestationRepository } from './handyman-bank-receipt-attestation.repository';
import { getPool } from '../../database';
import { maskAccountNumber } from '../handyman-bank-accounts/handyman-bank-account.types';

/**
 * CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — Bank receipt attestation read surface.
 *
 *   GET /handyman/bank-receipt-attestations/by-payment/:paymentId
 *   GET /handyman/bank-receipt-attestations/by-transaction/:transactionId
 *
 * Requires handyman.finance.read. Attestations are immutable; account numbers
 * are always masked. Cross-tenant access is denied by the existing ledger
 * building wall (caller's scope must be same client/building).
 *
 * This router is optional — the attestation is also returned implicitly via
 * payment confirmation event correlation. But we expose explicit reads for
 * Finance audit.
 */

function ensureUuid(raw: string, field: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUuid(trimmed)) {
    throw AppError.validation('Request validation failed.', [{ field, message: `${field} must be a valid UUID.` }]);
  }
  return trimmed;
}

export function createHandymanBankReceiptAttestationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const financeRead = requirePermission('handyman.finance.read');

  router.get('/handyman/bank-receipt-attestations/by-payment/:paymentId', auth, financeRead, async (req, res, next) => {
    try {
      const paymentId = ensureUuid(String(req.params.paymentId ?? ''), 'paymentId');
      const row = await handymanBankReceiptAttestationRepository.findAttestationByPaymentId(undefined, paymentId);
      if (!row) {
        res.json({ success: true, data: null });
        return;
      }
      // Mask bankTransactionId not needed — it's not sensitive; account number masked elsewhere.
      res.json({ success: true, data: row });
    } catch (e) { next(e); }
  });

  router.get('/handyman/bank-receipt-attestations/by-transaction/:transactionId', auth, financeRead, async (req, res, next) => {
    try {
      const transactionId = ensureUuid(String(req.params.transactionId ?? ''), 'transactionId');
      const rows = await getPool().query(
        `SELECT id, client_id, transaction_id, payment_id, destination_bank_account_id,
                bank_transaction_id, amount_credited, currency, bank_credited_at,
                verified_by_user_id, verified_at, bank_statement_evidence_ref, created_at
           FROM handyman_bank_receipt_attestations
          WHERE transaction_id = $1
          ORDER BY verified_at ASC, id ASC`,
        [transactionId],
      );
      res.json({ success: true, data: { transactionId, attestations: rows.rows } });
    } catch (e) { next(e); }
  });

  return router;
}
