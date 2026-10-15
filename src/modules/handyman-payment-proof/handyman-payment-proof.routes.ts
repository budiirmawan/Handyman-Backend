import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { ERROR_CODES } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  parseCustomerLedgerScopeParam,
  parseCustomerPaymentIdParam,
} from '../handyman-customer-ledger-api/handyman-customer-ledger-api.validation';
import {
  getHandymanPaymentProofMetadata,
  readHandymanPaymentProofContent,
} from './handyman-payment-proof.service';

/**
 * CR-HM-FIN-DOCUMENTS-01 — Finance payment-proof retrieval transport:
 *
 *   GET /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof
 *   GET /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof/content
 *
 * Payment-specific READ-ONLY door over the authoritative 0433 proof
 * (the CR-HM-13 payment URL family; NOT the generic evidence surface,
 * which has no payment-proof authority). Requires an authenticated
 * actor with `handyman.finance.read` (CR-HM-FIN-AUTH-01) plus the
 * exact-Building scope of the payment's execution scope (BE-02G) —
 * no `tenant_company.read` and no tenant-wide grant is implied or
 * accepted as a substitute.
 *
 * Deliberately separate surfaces, kept separate:
 *  - customer-submitted proof upload stays the Care workspace route;
 *  - Finance verification (confirm/reject) stays `handyman.finance.manage`;
 *  - this router only ever READS authentic bound proof bytes.
 *
 * No storage key, storage URL, signed URL or token is ever disclosed;
 * content is streamed through this authenticated route only.
 */
export function createHandymanPaymentProofRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const financeRead = requirePermission('handyman.finance.read');

  router.get(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof',
    auth,
    financeRead,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const executionScopeId = parseCustomerLedgerScopeParam(
          String(req.params.executionScopeId ?? ''),
        );
        const paymentId = parseCustomerPaymentIdParam(
          String(req.params.paymentId ?? ''),
        );
        const metadata = await getHandymanPaymentProofMetadata(
          executionScopeId,
          paymentId,
          req.auth.userId,
        );
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { paymentProof: metadata }, 200);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof/content',
    auth,
    financeRead,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const executionScopeId = parseCustomerLedgerScopeParam(
          String(req.params.executionScopeId ?? ''),
        );
        const paymentId = parseCustomerPaymentIdParam(
          String(req.params.paymentId ?? ''),
        );
        const { metadata, buffer } = await readHandymanPaymentProofContent(
          executionScopeId,
          paymentId,
          req.auth.userId,
        );
        res
          .status(200)
          .set('Cache-Control', 'no-store')
          .set('Content-Type', metadata.mimeType)
          .set('Content-Length', String(buffer.byteLength))
          .set(
            'Content-Disposition',
            `inline; filename*=UTF-8''${encodeURIComponent(
              metadata.originalFileName || 'payment-proof',
            )}`,
          )
          .send(buffer);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

/** Re-exported for contract tests asserting the bounded denial codes. */
export const PAYMENT_PROOF_ERROR_CODES = {
  NOT_FOUND: ERROR_CODES.HANDYMAN_PAYMENT_PROOF_NOT_FOUND,
  INTEGRITY_CONFLICT: ERROR_CODES.HANDYMAN_PAYMENT_PROOF_INTEGRITY_CONFLICT,
} as const;
