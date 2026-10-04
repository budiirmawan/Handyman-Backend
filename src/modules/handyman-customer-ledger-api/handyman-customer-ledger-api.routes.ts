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
 *   GET  /handyman/execution-scopes/:executionScopeId/customer-payments
 *   POST /handyman/execution-scopes/:executionScopeId/customer-payments
 *   POST /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm
 *   POST /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/reject
 *
 * Reads require `tenant_company.read` + `canAccessClient`.
 * Payment commands require `tenant_company.manage` + `canAccessClient`
 * + single-use `idempotencyKey`.
 */
export function createHandymanCustomerLedgerApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

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
    manage,
    postConfirmCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/reject',
    auth,
    manage,
    postRejectCustomerPaymentHandler,
  );

  return router;
}
