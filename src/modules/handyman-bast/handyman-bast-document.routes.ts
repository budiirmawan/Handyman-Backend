import { Router } from 'express';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { sendQuotationDocumentPdf } from '../handyman-quotations/handyman-quotation-document.routes';
import { downloadOfficialBastDocument } from './handyman-bast-document.service';

/** Local Building Care; workspace Care has its separate token-scoped route. */
export function createOfficialBastDocumentRouter(): Router {
  const router = Router();
  router.get('/handyman/basts/:bastId/document.pdf', authenticationMiddleware, async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (Object.keys(req.query).length || (req.body !== undefined &&
          (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) {
        throw AppError.validation('BAST document download accepts no context fields.');
      }
      const document = await downloadOfficialBastDocument(req.auth.userId, req.params.bastId as string);
      res.setHeader('X-BAST-Document-Id', document.id);
      res.setHeader('X-BAST-Document-Number', document.number);
      sendQuotationDocumentPdf(res, document);
    } catch (error) { next(error); }
  });
  return router;
}
