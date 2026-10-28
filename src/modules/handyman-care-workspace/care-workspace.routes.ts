import { downloadWarrantyCertificateForCare } from '../handyman-warranty-certificates/handyman-warranty-certificate.service';
import { sendWarrantyCertificatePdf } from '../handyman-warranty-certificates/handyman-warranty-certificate.routes';
import { downloadOfficialHandymanInvoiceForCare } from '../handyman-official-invoices/handyman-official-invoice.service';
import { sendOfficialInvoicePdf } from '../handyman-official-invoices/handyman-official-invoice.routes';
import { downloadOfficialBastDocumentForCare } from '../handyman-bast/handyman-bast-document.service';
import { downloadQuotationDocumentForCare } from '../handyman-quotations/handyman-quotation-document.service';
import { downloadVariationOfferDocumentForCare } from '../handyman-scope-variations/handyman-variation-offer-document.service';
import { recordWorkspaceCareDownload } from '../handyman-quotations/handyman-quotation-delivery.service';
import { sendQuotationDocumentPdf } from '../handyman-quotations/handyman-quotation-document.routes';
import { downloadTenantPaymentReceiptForCare } from '../handyman-tenant-receipts/handyman-tenant-receipt.service';
import { sendPaymentReceiptPdf } from '../handyman-tenant-receipts/handyman-tenant-receipt.routes';
import { getCareWorkspaceRequestDetail } from './care-workspace-request-detail.service';
import { getCareWorkspaceOperationalProjection } from './care-workspace-operational.service';
import multer from 'multer';
import { HANDYMAN_PAYMENT_PROOF_MAX_BYTES, assertCareHandymanPaymentProofContext, parseCareHandymanPaymentProofSelection, uploadCareHandymanPaymentProof } from './care-workspace-payment-proof.service';
import { listCareWorkspaceRequests } from './care-workspace-requests.service';
import { issueCareCreateExchange } from './care-create-exchange.service';
import { readCareWorkspaceCatalogue } from './care-workspace-catalogue.service';
import { Router } from 'express';
import { listCareWorkspaceScope, listCareWorkspaceTenants, listCareWorkspaceSpaces, listCareWorkspaceOccupancies } from './care-workspace-scope.service';
import { getAppConfig } from '../../config';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { isLoginRateLimited, recordLoginFailure, recordLoginSuccess } from '../auth/login-rate-limit';
import { admitCareWorkspace, resolveCareWorkspacePrincipal, revokeCareWorkspaceSession, workspaceUnauthorized } from './care-workspace.service';

/** Care-only credential surface; no local User middleware or grant administration. */
export function createCareWorkspaceRouter(): Router {
  const router = Router();
  const proofUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: HANDYMAN_PAYMENT_PROOF_MAX_BYTES, files: 1 } });
  router.post('/handyman/care/session', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // Existing local login-throttle convention, isolated namespace and socket
    // address (never trust a forwarded header). Only a FAILED admission consumes
    // quota, and a success resets it (auth.service.login convention): a BM host
    // relaying operator admissions server-to-server must not spend the failure
    // budget of every operator behind one egress address. The 429 gate, its
    // namespace and admission/session/crypto authority are unchanged.
    const key = `handyman-care-workspace:${req.socket.remoteAddress ?? 'unknown'}`;
    try {
      if (isLoginRateLimited(key)) {
        res.setHeader('Retry-After', String(getAppConfig().security.loginRateLimitWindowMinutes * 60));
        throw new AppError({ code: 'AUTH_RATE_LIMITED', message: 'Too many admission attempts.', statusCode: 429 });
      }
      if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not accepted.');
      const admitted = await admitCareWorkspace(req.body, req.header('x-hub-signature-256'));
      recordLoginSuccess(key);
      sendSuccess(res, admitted, 201);
    } catch (error) {
      // A throttle rejection is never charged back to the same namespace key.
      if (!(error instanceof AppError) || error.statusCode !== 429) recordLoginFailure(key);
      next(error);
    }
  });
  router.delete('/handyman/care/session', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      if (Object.keys(req.query).length ||
          (req.body !== undefined && (typeof req.body !== 'object' || req.body === null ||
            Array.isArray(req.body) || Object.keys(req.body).length))) {
        throw AppError.validation('Logout does not accept context fields.');
      }
      await revokeCareWorkspaceSession(match[1]);
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.get(['/handyman/care/properties', '/handyman/care/properties/:propertyId/buildings'], async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      const result = await listCareWorkspaceScope(match[1], req.query, req.params.propertyId, req.body);
      sendSuccess(res, result);
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/properties/:propertyId/tenant-companies', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await listCareWorkspaceTenants(match[1], req.query, req.params.propertyId, req.body));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/properties/:propertyId/spaces', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await listCareWorkspaceSpaces(match[1], req.query, req.params.propertyId, req.body));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/properties/:propertyId/occupancies', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await listCareWorkspaceOccupancies(match[1], req.query, req.params.propertyId, req.body));
    } catch (error) { next(error); }
  });
  for (const [path, kind] of [
    ['/handyman/care/properties/:propertyId/catalogue/services', 'services'],
    ['/handyman/care/properties/:propertyId/catalogue/material-profiles', 'profiles'],
    ['/handyman/care/properties/:propertyId/catalogue/material-profiles/:profileId', 'profiles'],
  ] as const) {
    router.get(path, async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
        if (!match) throw workspaceUnauthorized();
        const profileId = 'profileId' in req.params ? req.params.profileId : undefined;
        sendSuccess(res, await readCareWorkspaceCatalogue(match[1], req.params.propertyId,
          kind, req.query, profileId, req.body));
      } catch (error) { next(error); }
    });
  }
  router.post('/handyman/care/properties/:propertyId/create-exchanges', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await issueCareCreateExchange(match[1], req.params.propertyId, req.body, req.query), 201);
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await listCareWorkspaceRequests(match[1], req.query, req.body));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await getCareWorkspaceRequestDetail(match[1], req.params.requestId, req.query, req.body));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId/projection', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      sendSuccess(res, await getCareWorkspaceOperationalProjection(
        match[1], req.params.requestId, req.query, req.body));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId/warranty-certificates/:certificateId/document.pdf', async (req,res,next) => {
    res.setHeader('Cache-Control','private, no-store');
    try {
      const match=/^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))
        throw AppError.validation('Warranty download does not accept a body.');
      sendWarrantyCertificatePdf(res,await downloadWarrantyCertificateForCare(match[1],req.params.requestId,req.params.certificateId,req.query));
    } catch(error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId/invoices/:invoiceId/document.pdf', async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))
        throw AppError.validation('Invoice download does not accept a body.');
      sendOfficialInvoicePdf(res, await downloadOfficialHandymanInvoiceForCare(match[1],req.params.requestId,req.params.invoiceId,req.query));
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId/basts/:bastId/document.pdf', async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
        throw AppError.validation('BAST document download does not accept a body.');
      }
      const document = await downloadOfficialBastDocumentForCare(match[1], req.params.requestId, req.params.bastId, req.query);
      res.setHeader('X-BAST-Document-Id', document.id);
      res.setHeader('X-BAST-Document-Number', document.number);
      sendQuotationDocumentPdf(res, document);
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId/variations/:variationId/offer.pdf', async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
        throw AppError.validation('Variation offer download does not accept a body.');
      }
      const document = await downloadVariationOfferDocumentForCare(match[1], req.params.requestId, req.params.variationId, req.query);
      res.setHeader('X-Variation-Offer-Id', document.id);
      res.setHeader('X-Variation-Offer-Version', String(document.version));
      sendQuotationDocumentPdf(res, document);
    } catch (error) { next(error); }
  });
  router.get('/handyman/care/requests/:requestId/quotation-versions/:quotationVersionId/document.pdf', async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) {
        throw AppError.validation('Quotation document download does not accept a body.');
      }
      const document = await downloadQuotationDocumentForCare(match[1], req.params.requestId,
        req.params.quotationVersionId, req.query);
      await recordWorkspaceCareDownload(match[1], req.params.requestId as string, req.params.quotationVersionId as string, document.pdfChecksum);
      sendQuotationDocumentPdf(res, document);
    } catch (error) { next(error); }
  });
  router.get([
    '/handyman/care/requests/:requestId/payments/:paymentId/receipt.pdf',
    '/handyman/care/requests/:requestId/invoices/:invoiceId/payments/:paymentId/receipt.pdf',
  ], async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      const invoiceId = 'invoiceId' in req.params ? req.params.invoiceId : undefined;
      const receipt = await downloadTenantPaymentReceiptForCare(match[1], req.params.requestId,
        req.params.paymentId, req.query, invoiceId);
      sendPaymentReceiptPdf(res, receipt);
    } catch (error) { next(error); }
  });
  router.post([
    '/handyman/care/requests/:requestId/invoices/:invoiceId/payments/:paymentId/proof',
    '/handyman/care/requests/:requestId/payments/:paymentId/proof',
  ], async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!match) throw workspaceUnauthorized();
      const principal = await resolveCareWorkspacePrincipal(match[1]);
      if (Object.keys(req.query).length === 0) throw AppError.validation('Selected Care workspace context is required.');
      const selection = parseCareHandymanPaymentProofSelection(req.query);
      const invoiceId = 'invoiceId' in req.params ? req.params.invoiceId : null;
      await assertCareHandymanPaymentProofContext({ principal, selection,
        requestId: req.params.requestId, invoiceId, paymentId: req.params.paymentId });
      const file = await new Promise<Express.Multer.File>((resolve, reject) => {
        proofUpload.single('file')(req, res, error => {
          if (error) {
            reject(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
              ? AppError.badRequest('Uploaded file exceeds the 50 MB limit.')
              : AppError.badRequest('Payment proof upload failed.'));
            return;
          }
          const uploaded = (req as typeof req & { file?: Express.Multer.File }).file;
          if (!uploaded) { reject(AppError.validation('Multipart field \"file\" is required.')); return; }
          resolve(uploaded);
        });
      });
      const body = req.body as Record<string, unknown>;
      if (!body || Object.keys(body).some(key => key !== 'evidenceType')) {
        throw AppError.validation('Only evidenceType and the file field are accepted.');
      }
      const result = await uploadCareHandymanPaymentProof({ principal, selection,
        requestId: req.params.requestId, invoiceId, paymentId: req.params.paymentId,
        evidenceType: body.evidenceType,
        file: { buffer: file.buffer, mimetype: file.mimetype, originalname: file.originalname, size: file.size } });
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) { next(error); }
  });
  return router;
}
