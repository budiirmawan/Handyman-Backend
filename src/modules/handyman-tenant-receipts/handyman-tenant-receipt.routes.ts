import { Router, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { downloadTenantPaymentReceipt, issueTenantPaymentReceipt } from './handyman-tenant-receipt.service';

const base = '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/receipt';
export function sendPaymentReceiptPdf(res: Response, receipt: Awaited<ReturnType<typeof downloadTenantPaymentReceipt>>) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${receipt.filename}"`);
  res.setHeader('Content-Length', String(receipt.fileSize));
  res.setHeader('X-Document-Source-SHA256', receipt.sourceChecksum);
  res.setHeader('X-Content-SHA256', receipt.pdfChecksum);
  res.send(receipt.bytes);
}
export function createHandymanTenantReceiptRouter(): Router {
  const router = Router();
  router.post(base, authenticationMiddleware, requirePermission('handyman.finance.manage'), async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      if (Object.keys(req.query).length || (req.body !== undefined &&
          (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) {
        throw AppError.validation('No caller-supplied payment or issuance fields are accepted.');
      }
      const receipt = await issueTenantPaymentReceipt(req.auth.userId, { executionScopeId: req.params.executionScopeId as string,
        paymentId: req.params.paymentId as string });
      const downloadPath = `/api/v1/handyman/execution-scopes/${receipt.executionScopeId}/customer-payments/${receipt.paymentId}/receipt.pdf`;
      res.setHeader('Location', downloadPath);
      res.status(receipt.replayed ? 200 : 201).json({ data: { ...receipt, downloadPath } });
    } catch (error) { next(error); }
  });
  router.get(`${base}.pdf`, authenticationMiddleware, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
      const receipt = await downloadTenantPaymentReceipt(req.auth.userId, { executionScopeId: req.params.executionScopeId as string,
        paymentId: req.params.paymentId as string });
      sendPaymentReceiptPdf(res, receipt);
    } catch (error) { next(error); }
  });
  return router;
}
