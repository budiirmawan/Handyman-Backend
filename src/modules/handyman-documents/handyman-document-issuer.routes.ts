import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanDocumentIssuerProfileHandler,
  listHandymanDocumentIssuerProfileHistoryHandler,
  putHandymanDocumentIssuerProfileHandler,
} from './handyman-document-issuer.controller';

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — the issuer company profile surface:
 *
 *   GET /handyman/clients/:clientId/document-issuer-profile
 *   PUT /handyman/clients/:clientId/document-issuer-profile
 *   GET /handyman/clients/:clientId/document-issuer-profile/history
 *
 * TWO-LAYER AUTHORITY (the established Handyman configuration pattern):
 *   1. RBAC: `handyman.commercial.manage` for BOTH read and write — the
 *      existing "Author Handyman commercial agreements, pricing and BM-fee
 *      terms" code is the Handyman Operations Manager authority vocabulary, and
 *      no new permission code, role or seed entry is introduced by this part.
 *      The issuer identity is unpublished master data, so its read is gated by
 *      the same code rather than a tenant-facing read.
 *   2. the service-level provider-Client scope wall
 *      (`contextAccessService.canAccessClient`), which is what stops a
 *      same-permission manager of a DIFFERENT provider.
 *
 * WHO IS REFUSED, BY CONSTRUCTION: Building Customer Care holds
 * `handyman.care.building` (a mediation bridge only) and a Tenant PIC holds
 * `tenant_company.manage`; neither carries the commercial code, so both get
 * 403 PERMISSION_DENIED at the RBAC layer before any row is read — and a
 * tenant-side `tenant_company.manage` holder is additionally never inside the
 * provider-Client scope as a writer. `PUT` is the only write surface: there is
 * no create/replace/delete route, because the service writes an append-only
 * version chain. No binary upload route exists either: `logoReference` is a
 * media REFERENCE and stays that way in this part.
 */
export function createHandymanDocumentIssuerProfileRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('handyman.commercial.manage');

  router.get(
    '/handyman/clients/:clientId/document-issuer-profile/history',
    auth,
    manage,
    listHandymanDocumentIssuerProfileHistoryHandler,
  );
  router.get(
    '/handyman/clients/:clientId/document-issuer-profile',
    auth,
    manage,
    getHandymanDocumentIssuerProfileHandler,
  );
  router.put(
    '/handyman/clients/:clientId/document-issuer-profile',
    auth,
    manage,
    putHandymanDocumentIssuerProfileHandler,
  );

  return router;
}
