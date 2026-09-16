import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  decideHandymanQuotationApprovalInAppHandler,
  getHandymanQuotationApprovalHandler,
  getHandymanQuotationApprovalLinkHandler,
  issueHandymanQuotationApprovalLinkHandler,
  listHandymanQuotationApprovalLinksHandler,
  listHandymanQuotationApprovalsHandler,
  recordHandymanQuotationApprovalAssistedDecisionHandler,
  revokeHandymanQuotationApprovalLinkHandler,
} from './handyman-quotation-approval.controller';

/**
 * CR-HM-BE-03 RUN 4 — Handyman Quotation approval HTTP contract, registered
 * through the existing Asentra route composition (no separate server/runtime).
 * Every route requires an authenticated session; RBAC then gates per route
 * with the minimum correct permission:
 *
 * - IN_APP decision: authentication ONLY — deliberately NO general
 *   quotation-manage permission. The approving party is a tenant PIC, not
 *   staff; the Run 3 service resolves and verifies the actor exclusively
 *   through governed identity/context links (tenant_pics.user == actor, PIC
 *   linked to the request, tenant company + effective building context).
 *   There is no fabricated Tenant Relation role name anywhere.
 * - `handyman_quotation.read`                → approval reads
 * - `handyman_quotation_approval.record`     → ASSISTED recorded decision
 * - `handyman_quotation_approval_link.manage`→ staff secure-link readiness
 *                                              (issue / metadata reads / revoke)
 *
 * There is deliberately NO public resolve, public decide, anonymous token or
 * token-consumption endpoint: SECURE_LINK public exposure remains deferred
 * pending platform public-endpoint abuse protection. The raw link token is
 * returned exactly once (successful issue response) and token_hash is never
 * exposed.
 */
export function createHandymanQuotationApprovalRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('handyman_quotation.read');
  const linkManage = requirePermission('handyman_quotation_approval_link.manage');

  // Approval reads (staff surfaces as needed by the existing authority).
  router.get(
    '/handyman-quotations/:quotationId/approvals',
    auth,
    read,
    listHandymanQuotationApprovalsHandler,
  );
  router.get(
    '/handyman-quotation-approvals/:approvalId',
    auth,
    read,
    getHandymanQuotationApprovalHandler,
  );

  // IN_APP decision — authenticated tenant-PIC channel, NO permission gate.
  router.post(
    '/handyman-quotations/:quotationId/approvals/in-app-decision',
    auth,
    decideHandymanQuotationApprovalInAppHandler,
  );

  // ASSISTED decision — authenticated staff recording an out-of-band decision.
  router.post(
    '/handyman-quotations/:quotationId/approvals/assisted-decision',
    auth,
    requirePermission('handyman_quotation_approval.record'),
    recordHandymanQuotationApprovalAssistedDecisionHandler,
  );

  // Secure-link staff readiness — issue / metadata reads / revoke ONLY.
  router.post(
    '/handyman-quotation-approvals/:approvalId/links',
    auth,
    linkManage,
    issueHandymanQuotationApprovalLinkHandler,
  );
  router.get(
    '/handyman-quotations/:quotationId/approval-links',
    auth,
    linkManage,
    listHandymanQuotationApprovalLinksHandler,
  );
  router.get(
    '/handyman-quotation-approval-links/:linkId',
    auth,
    linkManage,
    getHandymanQuotationApprovalLinkHandler,
  );
  router.post(
    '/handyman-quotation-approval-links/:linkId/revoke',
    auth,
    linkManage,
    revokeHandymanQuotationApprovalLinkHandler,
  );

  return router;
}
