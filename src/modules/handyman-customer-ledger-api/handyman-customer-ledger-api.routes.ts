import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getClientCustomerLedgerHandler,
  getExecutionScopeCustomerLedgerHandler,
  getExecutionScopeCustomerPaymentsHandler,
  postConfirmCustomerPaymentHandler,
  postRecordCustomerPaymentHandler,
  postRejectCustomerPaymentHandler,
} from './handyman-customer-ledger-api.controller';

/**
 * CR-HM-17 GAP PART 05 — CR-HM-13 Customer Transaction & Payment Ledger
 * HTTP transport surface:
 *
 *   GET  /handyman/execution-scopes/:executionScopeId/customer-ledger
 *   GET  /handyman/customer-ledger
 *   GET  /handyman/execution-scopes/:executionScopeId/financial-ledger
 *   GET  /handyman/execution-scopes/:executionScopeId/customer-payments
 *   POST /handyman/execution-scopes/:executionScopeId/customer-payments
 *   POST /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm
 *   POST /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/reject
 *
 * Scope reads require `tenant_company.read` + exact-Building access to
 * the scope's server-derived Building (BE-02G — the former client-level
 * `canAccessClient` wall was replaced by CR-HM-SEC-01); the client-basis
 * read (`GET /handyman/customer-ledger`) keeps `canAccessClient` plus the
 * exact requested Building check.
 * Payment REPORTING (record) requires `tenant_company.manage` + the same
 * exact-Building wall + single-use `idempotencyKey` — reporting a payment
 * is a Customer/Tenant action, not Finance verification.
 * Payment VERIFICATION (confirm / reject) requires
 * `handyman.finance.manage` (CR-HM-FIN-AUTH-01) + scope: generic
 * `tenant_company.manage` alone can no longer verify money.
 *
 * CR-HM-FIN-DOCUMENTS-01 — Finance detail-read door:
 *   GET /handyman/execution-scopes/:executionScopeId/financial-ledger
 * is the SAME frozen CR-HM-13 read contract (`readHandymanLedgerTransactionAt`,
 * exact-Building wall included) mounted behind `handyman.finance.read`
 * (CR-HM-FIN-AUTH-01 financial read surfaces). It exists so a Finance
 * verifier can read charge-line/payment detail for the exact authorized
 * transaction WITHOUT holding the tenant-wide `tenant_company.read`.
 * No existing gate is changed: `tenant_company.read` stays required on
 * the customer-ledger doors, and the intentionally client-wide
 * `GET /handyman/customer-ledger` is NOT re-gated for Finance — Finance
 * receives no tenant-wide read here.
 */
export function createHandymanCustomerLedgerApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  const financeVerify = requirePermission('handyman.finance.manage');
  const financeRead = requirePermission('handyman.finance.read');

  router.get(
    '/handyman/execution-scopes/:executionScopeId/customer-ledger',
    auth,
    read,
    getExecutionScopeCustomerLedgerHandler,
  );
  router.get(
    '/handyman/customer-ledger',
    auth,
    read,
    getClientCustomerLedgerHandler,
  );
  // CR-HM-FIN-DOCUMENTS-01 — minimal Finance detail-read door: the same
  // frozen CR-HM-13 transaction read (charge lines, payments, allocations,
  // corrections, gross/net totals) behind `handyman.finance.read`, scoped
  // to ONE execution scope. The service enforces the exact-Building wall;
  // this door grants Finance no tenant-wide read (`GET /handyman/customer-ledger`
  // stays `tenant_company.read`-only).
  router.get(
    '/handyman/execution-scopes/:executionScopeId/financial-ledger',
    auth,
    financeRead,
    getExecutionScopeCustomerLedgerHandler,
  );
  router.get(
    '/handyman/execution-scopes/:executionScopeId/customer-payments',
    auth,
    read,
    getExecutionScopeCustomerPaymentsHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-payments',
    auth,
    manage,
    postRecordCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm',
    auth,
    financeVerify,
    postConfirmCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/reject',
    auth,
    financeVerify,
    postRejectCustomerPaymentHandler,
  );

  return router;
}
