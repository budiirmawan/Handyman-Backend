import { Router, type RequestHandler } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanExecutionScopeHandler,
  getHandymanPresentedQuotationHandler,
  getHandymanQuotationDecisionHandler,
  getHandymanQuotationHandler,
  getHandymanQuotationLinesHandler,
  getHandymanQuotationTotalsHandler,
  postHandymanQuotationDecisionHandler,
  postHandymanQuotationExpireHandler,
  postHandymanQuotationHandler,
  postHandymanQuotationIssueHandler,
  postHandymanQuotationLineHandler,
  postHandymanQuotationRevisionHandler,
  postHandymanQuotationSupersedeHandler,
} from './handyman-quotations-api.controller';

/**
 * CR-HM-06 PART 07A — Handyman quotation surface (FROZEN F1–F12 +
 * PART 06 HTTP handoff): exactly the existing PART 01–05 public
 * service operations (13 operations / 7 paths, nothing invented):
 *
 *   POST /handyman/requests/:handymanRequestId/quotation            manage
 *   GET  /handyman/requests/:handymanRequestId/quotation            read
 *   GET  /handyman/requests/:handymanRequestId/quotation/presented  read
 *   POST /handyman/quotations/:quotationId/versions                 manage
 *   POST /handyman/quotation-versions/:quotationVersionId/lines     manage
 *   GET  /handyman/quotation-versions/:quotationVersionId/lines     read
 *   GET  /handyman/quotation-versions/:quotationVersionId/totals    read
 *   POST /handyman/quotation-versions/:quotationVersionId/issue     manage
 *   POST /handyman/quotation-versions/:quotationVersionId/expire    manage
 *   POST /handyman/quotation-versions/:quotationVersionId/supersede manage
 *   POST /handyman/quotation-versions/:quotationVersionId/decision  manage
 *   GET  /handyman/quotation-versions/:quotationVersionId/decision  read
 *   GET  /handyman/quotation-versions/:quotationVersionId/
 *        execution-scope                                             read
 *
 * Permissions: reads `tenant_company.read`; mutations
 * `tenant_company.manage` (existing vocabulary). Actor is always the
 * authenticated session user; customer/client/location lineage is
 * service-derived. The explicit supersede route exposes the genuine
 * public service (ISSUED-withdrawal), not an internal helper. The
 * minimum Execution Scope read (bounded, by approved quotation
 * version) exists solely for quotation-approval result + downstream
 * target discovery per the PART 06 handoff — NO crew/scheduling/
 * arrival/work-session/payment/BAST/FM routes exist here.
 */
export function createHandymanQuotationsApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  const versionGet = (suffix: string, handler: RequestHandler) =>
    router.get(
      `/handyman/quotation-versions/:quotationVersionId${suffix}`,
      auth,
      read,
      handler,
    );
  const versionPost = (suffix: string, handler: RequestHandler) =>
    router.post(
      `/handyman/quotation-versions/:quotationVersionId${suffix}`,
      auth,
      manage,
      handler,
    );

  router.post(
    '/handyman/requests/:handymanRequestId/quotation',
    auth,
    manage,
    postHandymanQuotationHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/quotation',
    auth,
    read,
    getHandymanQuotationHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/quotation/presented',
    auth,
    read,
    getHandymanPresentedQuotationHandler,
  );
  router.post(
    '/handyman/quotations/:quotationId/versions',
    auth,
    manage,
    postHandymanQuotationRevisionHandler,
  );
  versionPost('/lines', postHandymanQuotationLineHandler);
  versionGet('/lines', getHandymanQuotationLinesHandler);
  versionGet('/totals', getHandymanQuotationTotalsHandler);
  versionPost('/issue', postHandymanQuotationIssueHandler);
  versionPost('/expire', postHandymanQuotationExpireHandler);
  versionPost('/supersede', postHandymanQuotationSupersedeHandler);
  versionPost('/decision', postHandymanQuotationDecisionHandler);
  versionGet('/decision', getHandymanQuotationDecisionHandler);
  versionGet('/execution-scope', getHandymanExecutionScopeHandler);
  return router;
}
