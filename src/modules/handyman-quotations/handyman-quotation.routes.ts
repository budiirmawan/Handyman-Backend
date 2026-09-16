import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  addHandymanQuotationLineHandler,
  createHandymanQuotationHandler,
  createHandymanQuotationRevisionHandler,
  getHandymanQuotationHandler,
  getHandymanQuotationRevisionHandler,
  listHandymanQuotationLinesHandler,
  listHandymanQuotationRevisionsHandler,
  listRequestHandymanQuotationsHandler,
  removeHandymanQuotationLineHandler,
  sendHandymanQuotationHandler,
  submitHandymanQuotationRevisionHandler,
  updateHandymanQuotationLineHandler,
  withdrawHandymanQuotationHandler,
} from './handyman-quotation.controller';

/**
 * CR-HM-BE-03 RUN 4 — Handyman Quotation commerce HTTP contract, registered
 * through the existing Asentra route composition (no separate server/runtime).
 * Every route requires an authenticated session; RBAC then gates per route
 * with the minimum correct permission:
 *
 * - `handyman_quotation.read`   → quotation/revision/line reads
 * - `handyman_quotation.manage` → create, revision authoring, DRAFT line
 *                                 add/update/remove, submit, withdraw
 * - `handyman_quotation.send`   → the governed send of an exact revision
 *
 * Scope comes from the route, the actor only from req.auth, and pricing is
 * service-authoritative through the UNCHANGED Run 2 governed lookup: derived
 * totals, client/building authority, customer snapshot, revision_number,
 * quotation_number and sent_revision_id are never accepted from a caller —
 * the send command carries exactly the explicit revision identifier. All
 * lifecycle/concurrency guards stay in the Run 2 services. Approval decision
 * routes live in the dedicated approval router.
 */
export function createHandymanQuotationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('handyman_quotation.read');
  const manage = requirePermission('handyman_quotation.manage');

  router.post(
    '/handyman-requests/:handymanRequestId/quotations',
    auth,
    manage,
    createHandymanQuotationHandler,
  );
  router.get(
    '/handyman-requests/:handymanRequestId/quotations',
    auth,
    read,
    listRequestHandymanQuotationsHandler,
  );
  router.get('/handyman-quotations/:quotationId', auth, read, getHandymanQuotationHandler);
  router.post(
    '/handyman-quotations/:quotationId/send',
    auth,
    requirePermission('handyman_quotation.send'),
    sendHandymanQuotationHandler,
  );
  router.post(
    '/handyman-quotations/:quotationId/withdraw',
    auth,
    manage,
    withdrawHandymanQuotationHandler,
  );

  router.post(
    '/handyman-quotations/:quotationId/revisions',
    auth,
    manage,
    createHandymanQuotationRevisionHandler,
  );
  router.get(
    '/handyman-quotations/:quotationId/revisions',
    auth,
    read,
    listHandymanQuotationRevisionsHandler,
  );
  router.get(
    '/handyman-quotation-revisions/:revisionId',
    auth,
    read,
    getHandymanQuotationRevisionHandler,
  );
  router.post(
    '/handyman-quotation-revisions/:revisionId/submit',
    auth,
    manage,
    submitHandymanQuotationRevisionHandler,
  );

  router.post(
    '/handyman-quotation-revisions/:revisionId/lines',
    auth,
    manage,
    addHandymanQuotationLineHandler,
  );
  router.get(
    '/handyman-quotation-revisions/:revisionId/lines',
    auth,
    read,
    listHandymanQuotationLinesHandler,
  );
  router.patch(
    '/handyman-quotation-lines/:lineId',
    auth,
    manage,
    updateHandymanQuotationLineHandler,
  );
  router.delete(
    '/handyman-quotation-lines/:lineId',
    auth,
    manage,
    removeHandymanQuotationLineHandler,
  );

  return router;
}
