import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  activatePaymentReceiptNumberingHandler,
  getHandymanDocumentSettingsHandler,
  listHandymanDocumentSettingsHandler,
  listHandymanDocumentSettingsHistoryHandler,
  putHandymanDocumentSettingsHandler,
} from './handyman-document-settings.controller';

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — the document settings surface:
 *
 *   GET /handyman/clients/:clientId/document-settings
 *   GET /handyman/clients/:clientId/document-settings/:documentKind/:language
 *   PUT /handyman/clients/:clientId/document-settings/:documentKind/:language
 *   GET /handyman/clients/:clientId/document-settings/:documentKind/:language/history
 *   POST /handyman/clients/:clientId/document-settings/PAYMENT_RECEIPT/:language/numbering/activate
 *
 * TWO-LAYER AUTHORITY, identical to the issuer profile and the bank accounts:
 *   1. RBAC: `handyman.commercial.manage` for read AND write - the existing
 *      Handyman commercial-authority code, with no new permission, role or seed
 *      entry. These settings are unpublished master data that shape a
 *      customer-facing document, so the read is not tenant-facing either.
 *   2. the service-level provider-Client scope wall (`canAccessClient`), which
 *      is what stops a same-permission manager of a DIFFERENT provider.
 *
 * DENIED BY CONSTRUCTION: Building Customer Care (`handyman.care.building`) and a
 * Tenant PIC (`tenant_company.manage`) hold no commercial code, so both are
 * refused before a row is read - a tenant can never rewrite the terms it is
 * offered, and Care can neither. There is no create, delete or "issue" route: the
 * PUT appends a version of the effective configuration; the separate Payment
 * Receipt activation records an explicit approval. Neither action mints a document number, accept a BAST, activate a warranty, set a
 * price or sign anything.
 */
export function createHandymanDocumentSettingsRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('handyman.commercial.manage');
  const base = '/handyman/clients/:clientId/document-settings';
  const byKey = `${base}/:documentKind/:language`;

  router.get(base, auth, manage, listHandymanDocumentSettingsHandler);
  router.get(`${byKey}/history`, auth, manage, listHandymanDocumentSettingsHistoryHandler);
  router.get(byKey, auth, manage, getHandymanDocumentSettingsHandler);
  router.put(byKey, auth, manage, putHandymanDocumentSettingsHandler);
  router.post(`${byKey}/numbering/activate`, auth, manage, activatePaymentReceiptNumberingHandler);

  return router;
}
