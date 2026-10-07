import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { rfqVendorSessionMiddleware } from '../rfq-vendor-invitations';
import {
  addVendorQuotationAttachmentHandler,
  addVendorQuotationLineHandler,
  createVendorQuotationHandler,
  createVendorQuotationRevisionHandler,
  getInternalQuotationHandler,
  getVendorCurrentQuotationHandler,
  getVendorQuotationAttachmentHandler,
  getVendorQuotationHandler,
  listInternalQuotationAttachmentsHandler,
  listInternalQuotationRevisionsHandler,
  listRfqQuotationsHandler,
  listVendorQuotationAttachmentsHandler,
  listVendorQuotationRevisionsHandler,
  submitVendorQuotationRevisionHandler,
  updateVendorQuotationLineHandler,
  updateVendorQuotationRevisionHandler,
} from './vendor-quotation.controller';

/**
 * CR-BE-PRO-02 PART 03 — Vendor Quotation + immutable revisions.
 *
 * Vendor routes use the invitation-scoped external session only. Internal
 * quotation reads use the existing RFQ read permission and Building scope.
 * No comparison, recommendation, approval, award, PO, or finance route lives
 * here.
 */
export function createVendorQuotationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('rfq.read');

  // Vendor-owned quotation and revision commands.
  router.post('/vendor-rfq-access/invitations/:invitationId/quotations', rfqVendorSessionMiddleware, createVendorQuotationHandler);
  router.get('/vendor-rfq-access/quotations/current', rfqVendorSessionMiddleware, getVendorCurrentQuotationHandler);
  router.get('/vendor-rfq-access/quotations/:quotationId', rfqVendorSessionMiddleware, getVendorQuotationHandler);
  router.get('/vendor-rfq-access/quotations/:quotationId/revisions', rfqVendorSessionMiddleware, listVendorQuotationRevisionsHandler);
  router.post('/vendor-rfq-access/quotations/:quotationId/revisions', rfqVendorSessionMiddleware, createVendorQuotationRevisionHandler);
  router.patch('/vendor-rfq-access/quotation-revisions/:revisionId', rfqVendorSessionMiddleware, updateVendorQuotationRevisionHandler);
  router.post('/vendor-rfq-access/quotation-revisions/:revisionId/lines', rfqVendorSessionMiddleware, addVendorQuotationLineHandler);
  router.patch('/vendor-rfq-access/quotation-lines/:lineId', rfqVendorSessionMiddleware, updateVendorQuotationLineHandler);
  router.post('/vendor-rfq-access/quotation-revisions/:revisionId/submit', rfqVendorSessionMiddleware, submitVendorQuotationRevisionHandler);
  router.post('/vendor-rfq-access/quotation-revisions/:revisionId/attachments', rfqVendorSessionMiddleware, addVendorQuotationAttachmentHandler);
  router.get('/vendor-rfq-access/quotation-revisions/:revisionId/attachments', rfqVendorSessionMiddleware, listVendorQuotationAttachmentsHandler);
  router.get('/vendor-rfq-access/quotation-attachments/:attachmentId', rfqVendorSessionMiddleware, getVendorQuotationAttachmentHandler);

  // Internal RFQ-scoped quotation reads. Internal users see all invited
  // Vendor quotations in their accessible Building, including revisions and
  // attachment metadata, but no new award authority is introduced.
  router.get('/rfqs/:rfqId/quotations', auth, read, listRfqQuotationsHandler);
  router.get('/vendor-quotations/:quotationId', auth, read, getInternalQuotationHandler);
  router.get('/vendor-quotations/:quotationId/revisions', auth, read, listInternalQuotationRevisionsHandler);
  router.get('/quotation-revisions/:revisionId/attachments', auth, read, listInternalQuotationAttachmentsHandler);

  return router;
}
