import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  activateHandymanDocumentBankAccountHandler,
  createHandymanDocumentBankAccountHandler,
  deactivateHandymanDocumentBankAccountHandler,
  getHandymanDocumentBankAccountHandler,
  listHandymanDocumentBankAccountHistoryHandler,
  listHandymanDocumentBankAccountsHandler,
  updateHandymanDocumentBankAccountHandler,
} from './handyman-document-bank.controller';

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — the issuer company bank account surface:
 *
 *   POST /handyman/clients/:clientId/document-bank-accounts
 *   GET  /handyman/clients/:clientId/document-bank-accounts
 *   GET  /handyman/clients/:clientId/document-bank-accounts/:bankAccountId
 *   PUT  /handyman/clients/:clientId/document-bank-accounts/:bankAccountId
 *   GET  /handyman/clients/:clientId/document-bank-accounts/:bankAccountId/history
 *   POST /handyman/clients/:clientId/document-bank-accounts/:bankAccountId/activate
 *   POST /handyman/clients/:clientId/document-bank-accounts/:bankAccountId/deactivate
 *
 * TWO-LAYER AUTHORITY, identical to the issuer profile so one grant cannot leak
 * into the other subject by accident:
 *   1. RBAC: `handyman.commercial.manage` for read AND write - the existing
 *      Handyman commercial-authority code, with no new permission, role or seed
 *      entry. `activate` / `deactivate` deliberately reuse the SAME code as the
 *      content writes rather than inventing a "can verify a bank account"
 *      permission: the escalation guard is that no body anywhere accepts a
 *      status, default flag or verification timestamp, so the only way to become
 *      a payment destination is the activation contract itself.
 *   2. the service-level provider-Client scope wall (`canAccessClient`), which
 *      is what stops a same-permission manager of a DIFFERENT provider.
 *
 * WHO IS REFUSED, BY CONSTRUCTION: Building Customer Care (`handyman.care.building`)
 * and a Tenant PIC (`tenant_company.manage`) hold no commercial code, so both get
 * 403 before a row is read - a tenant can never redirect the money it owes, and a
 * Care actor can never touch provider money data. There is no DELETE route: a
 * receiving account is retired by the lifecycle, never erased.
 */
export function createHandymanDocumentBankAccountRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('handyman.commercial.manage');
  const base = '/handyman/clients/:clientId/document-bank-accounts';

  router.post(base, auth, manage, createHandymanDocumentBankAccountHandler);
  router.get(base, auth, manage, listHandymanDocumentBankAccountsHandler);
  router.get(`${base}/:bankAccountId/history`, auth, manage, listHandymanDocumentBankAccountHistoryHandler);
  router.get(`${base}/:bankAccountId`, auth, manage, getHandymanDocumentBankAccountHandler);
  router.put(`${base}/:bankAccountId`, auth, manage, updateHandymanDocumentBankAccountHandler);
  router.post(
    `${base}/:bankAccountId/activate`,
    auth,
    manage,
    activateHandymanDocumentBankAccountHandler,
  );
  router.post(
    `${base}/:bankAccountId/deactivate`,
    auth,
    manage,
    deactivateHandymanDocumentBankAccountHandler,
  );

  return router;
}
