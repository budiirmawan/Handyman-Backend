import { Router, type RequestHandler } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanExecutionScopeHandler,
  getHandymanQuotationApprovalBindingHandler,
  postHandymanQuotationApprovalBindingHandler,
  postHandymanQuotationApprovalBindingRevokeHandler,
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
 * service operations at the time it shipped (13 operations / 7 paths,
 * nothing invented). W03 PART 03B2 later adds three approval-binding
 * operations to THIS router (2 write + 1 read, listed after the
 * PART 07A list below), so the quotation surface is now 16 operations.
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
 *   POST /handyman/quotations/:quotationId/approval-binding
 *                                          manage + binding.manage    write
 *   POST /handyman/quotations/:quotationId/approval-binding/revoke
 *                                          manage + binding.manage    write
 *   GET  /handyman/quotations/:quotationId/approval-binding         read
 *
 * W03 PART 03B2 (CR-HM-06/A01 v1.1 + ADD-A C21/C22) adds the three
 * approval-binding operations above: the ONLY write surface of the `0437`
 * Tenant PIC approval-binding ledger. They are mounted on the STAFF surface
 * because binding is a management act (ADD-A B8/B10) and they are additive —
 * no existing operation changed its path, permission, or semantics.
 *
 * A binding is NOT approval: nothing here can write
 * `handyman_quotation_decisions`, whose own guard independently refuses every
 * non-`TENANT_PIC` row (B9). No PIC-facing surface exists here (03D/03E).
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
  /**
   * ADD-A B8 keeps `tenant_company.manage` + BE-02G as the binding authority;
   * W03 PART 03B2 item 7 layers a DEDICATED code on top of it (never instead
   * of it), so the surface is strictly narrower than B8 alone and resolves
   * nobody by default (UNASSIGNED_BY_DEFAULT_PERMISSION_CODES — provisioning
   * is an explicit administrative act). BLK-BIND-SCOPE answered, not widened:
   * the literal below is what the registry gate
   * (`tests/config-perm-01-permission-registry.test.ts`) scans and verifies.
   */
  const approvalBindingManage = requirePermission(
    'handyman.quotation.approval.binding.manage',
  );

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

  // ---- W03 PART 03B2 — Tenant PIC approval-binding ledger (C21/C22) ------
  const bindingPath = '/handyman/quotations/:quotationId/approval-binding';
  router.post(
    bindingPath,
    auth,
    manage,
    approvalBindingManage,
    postHandymanQuotationApprovalBindingHandler,
  );
  router.post(
    `${bindingPath}/revoke`,
    auth,
    manage,
    approvalBindingManage,
    postHandymanQuotationApprovalBindingRevokeHandler,
  );
  router.get(
    bindingPath,
    auth,
    read,
    getHandymanQuotationApprovalBindingHandler,
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
