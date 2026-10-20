import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { isValidUuid } from '../clients';
import { AppError } from '../../shared/errors';
import {
  createHandymanBankAccount,
  listHandymanBankAccounts,
  getHandymanBankAccount,
  deactivateHandymanBankAccount,
} from './handyman-bank-account.service';

/**
 * CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — Destination bank account HTTP surface.
 *
 *   POST   /handyman/bank-accounts
 *   GET    /handyman/bank-accounts?clientId=&buildingId=&includeInactive=
 *   GET    /handyman/bank-accounts/:accountId
 *   POST   /handyman/bank-accounts/:accountId/deactivate
 *
 * All routes require handyman.finance.manage or handyman.finance.read as appropriate,
 * plus Client / exact-Building scope enforced in the service layer.
 * Account numbers are always masked (last 4) in responses; full numbers are never
 * returned via API and never logged in operational events.
 */

function ensureUuid(raw: string, field: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUuid(trimmed)) {
    throw AppError.validation('Request validation failed.', [{ field, message: `${field} must be a valid UUID.` }]);
  }
  return trimmed;
}

export function createHandymanBankAccountRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const financeManage = requirePermission('handyman.finance.manage');
  const financeRead = requirePermission('handyman.finance.read');

  // Create
  router.post('/handyman/bank-accounts', auth, financeManage, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!isValidUuid(String(body.clientId ?? ''))) {
        throw AppError.validation('Request validation failed.', [{ field: 'clientId', message: 'clientId must be a valid UUID.' }]);
      }
      const result = await createHandymanBankAccount(
        {
          clientId: String(body.clientId),
          buildingId: body.buildingId ? String(body.buildingId) : null,
          bankName: String(body.bankName ?? ''),
          accountNumber: String(body.accountNumber ?? ''),
          accountHolderName: String(body.accountHolderName ?? ''),
          displayName: String(body.displayName ?? body.bankName ?? ''),
          currency: String(body.currency ?? 'IDR'),
        },
        (req as any).auth.userId,
      );
      res.status(201).json({ success: true, data: result });
    } catch (e) {
      next(e);
    }
  });

  // List
  router.get('/handyman/bank-accounts', auth, financeRead, async (req, res, next) => {
    try {
      const q = req.query as Record<string, string>;
      const clientId = ensureUuid(String(q.clientId ?? ''), 'clientId');
      const buildingId = q.buildingId ? String(q.buildingId) : null;
      const includeInactive = String(q.includeInactive ?? '').toLowerCase() === 'true';
      const rows = await listHandymanBankAccounts(clientId, (req as any).auth.userId, { buildingId, includeInactive });
      res.json({ success: true, data: { clientId, bankAccounts: rows } });
    } catch (e) {
      next(e);
    }
  });

  // Get one
  router.get('/handyman/bank-accounts/:accountId', auth, financeRead, async (req, res, next) => {
    try {
      const accountId = ensureUuid(String(req.params.accountId ?? ''), 'accountId');
      const row = await getHandymanBankAccount(accountId, (req as any).auth.userId);
      res.json({ success: true, data: row });
    } catch (e) {
      next(e);
    }
  });

  // Deactivate
  router.post('/handyman/bank-accounts/:accountId/deactivate', auth, financeManage, async (req, res, next) => {
    try {
      const accountId = ensureUuid(String(req.params.accountId ?? ''), 'accountId');
      const row = await deactivateHandymanBankAccount(accountId, (req as any).auth.userId);
      res.json({ success: true, data: row });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
