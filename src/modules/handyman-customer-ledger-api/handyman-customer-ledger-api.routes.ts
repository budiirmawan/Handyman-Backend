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
 * Payment reporting (POST customer-payments) requires
 * `handyman.payment.report` + `canAccessClient` + `idempotencyKey`.
 * Payment verification (POST .../confirm, POST .../reject) requires
 * `handyman.payment.verify` + `canAccessClient` + `idempotencyKey`, and the
 * verifier must not be the recorder of that payment (maker-checker).
 */
export function createHandymanCustomerLedgerApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  // PART 04: payment reporting and payment verification are separate
  // explicit permissions. tenant_company.manage no longer authorizes either.
  const report = requirePermission('handyman.payment.report');
  const verify = requirePermission('handyman.payment.verify');

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
    report,
    postRecordCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm',
    auth,
    verify,
    postConfirmCustomerPaymentHandler,
  );
  router.post(
    '/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/reject',
    auth,
    verify,
    postRejectCustomerPaymentHandler,
  );

  return router;
}
