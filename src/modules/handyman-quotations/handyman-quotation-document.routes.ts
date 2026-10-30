import { Router, type Response } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { downloadQuotationDocument } from './handyman-quotation-document.service';
import { recordLocalCareDownload } from './handyman-quotation-delivery.service';

export function sendQuotationDocumentPdf(res: Response, document: Awaited<ReturnType<typeof downloadQuotationDocument>>) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
  res.setHeader('Content-Length', String(document.fileSize));
  res.setHeader('X-Document-Id', document.id);
  res.setHeader('X-Document-Source-SHA256', document.sourceChecksum);
  res.setHeader('X-Content-SHA256', document.pdfChecksum);
  res.send(document.bytes);
}

/** Mounted within the quotation API; service enforces Operations or Building Care. */
export function createQuotationDocumentRouter(): Router {
  const router = Router();
  router.get('/handyman/quotation-versions/:quotationVersionId/document.pdf', authenticationMiddleware, async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (Object.keys(req.query).length || (req.body !== undefined &&
          (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) {
        throw AppError.validation('Quotation document download accepts no context fields.');
      }
      const versionId = req.params.quotationVersionId as string;
      const document = await downloadQuotationDocument(req.auth.userId, versionId);
      await recordLocalCareDownload(req.auth.userId, versionId, document.pdfChecksum);
      sendQuotationDocumentPdf(res, document);
    } catch (error) { next(error); }
  });
  return router;
}
