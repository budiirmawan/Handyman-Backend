import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { downloadIssuedBmDocument, issueBmCommissionStatement, issueBmMonthlyServiceReport,
  listIssuedBmDocuments } from './handyman-bm-documents.service';

const base = '/handyman/clients/:clientId/buildings/:buildingId/bm-documents';
function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) {
    throw AppError.validation('Unexpected issuance request fields.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw AppError.validation(`Invalid ${field}.`);
  return value;
}
function downloadPath(clientId: string, buildingId: string, id: string): string {
  return `/api/v1/handyman/clients/${clientId}/buildings/${buildingId}/bm-documents/${id}.pdf`;
}
export function createHandymanBmDocumentsRouter(): Router {
  const router = Router(), auth = authenticationMiddleware, manager = requirePermission('handyman.commercial.manage');
  router.post(`${base}/commission-statements`, auth, manager, requirePermission('handyman.finance.read'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
        const b = body(req.body, ['counterpartyId','agreementVersionId','dateFrom','dateTo','idempotencyKey']);
        const result = await issueBmCommissionStatement(req.auth.userId, { clientId: req.params.clientId as string,
          buildingId: req.params.buildingId as string, counterpartyId: text(b.counterpartyId,'counterpartyId'),
          agreementVersionId: text(b.agreementVersionId,'agreementVersionId'), dateFrom: text(b.dateFrom,'dateFrom'),
          dateTo: text(b.dateTo,'dateTo'), idempotencyKey: text(b.idempotencyKey,'idempotencyKey') });
        const path = downloadPath(result.clientId,result.buildingId,result.id); res.setHeader('Location',path);
        res.status(result.replayed ? 200 : 201).json({ data: { ...result, downloadPath: path } });
      } catch (error) { next(error); }
    });
  router.post(`${base}/monthly-service-reports`, auth, manager, requirePermission('tenant_company.read'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
        const b = body(req.body, ['month','idempotencyKey']);
        const result = await issueBmMonthlyServiceReport(req.auth.userId, { clientId: req.params.clientId as string,
          buildingId: req.params.buildingId as string, month: text(b.month,'month'), idempotencyKey: text(b.idempotencyKey,'idempotencyKey') });
        const path = downloadPath(result.clientId,result.buildingId,result.id); res.setHeader('Location',path);
        res.status(result.replayed ? 200 : 201).json({ data: { ...result, downloadPath: path } });
      } catch (error) { next(error); }
    });
  router.get(base, auth, manager, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      if (Object.keys(req.query).some(k => !['documentType','limit','after'].includes(k)) ||
          typeof req.query.documentType !== 'string' || (req.query.after !== undefined && typeof req.query.after !== 'string') ||
          (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^[1-9][0-9]*$/.test(req.query.limit)))) {
        throw AppError.validation('Invalid document history query.');
      }
      const result = await listIssuedBmDocuments(req.auth.userId, { clientId: req.params.clientId as string,
        buildingId: req.params.buildingId as string, documentType: req.query.documentType as 'COMMISSION_STATEMENT' | 'MONTHLY_SERVICE_REPORT',
        ...(req.query.limit === undefined ? {} : { limit: Number(req.query.limit) }),
        ...(req.query.after === undefined ? {} : { after: req.query.after as string }) });
      res.json({ data: result });
    } catch (error) { next(error); }
  });
  router.get(`${base}/:documentId.pdf`, auth, manager, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      if (Object.keys(req.query).length) throw AppError.validation('No query fields are accepted.');
      const doc = await downloadIssuedBmDocument(req.auth.userId, { clientId: req.params.clientId as string,
        buildingId: req.params.buildingId as string, documentId: req.params.documentId as string });
      res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Disposition',`attachment; filename="${doc.filename}"`);
      res.setHeader('Content-Length',String(doc.fileSize)); res.setHeader('X-Document-Source-SHA256',doc.sourceChecksum);
      res.setHeader('X-Content-SHA256',doc.pdfChecksum); res.send(doc.bytes);
    } catch (error) { next(error); }
  });
  return router;
}
