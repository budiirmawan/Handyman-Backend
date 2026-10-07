import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  createSaasBillingAccountHandler,
  getSaasBillingAccountHandler,
  listSaasBillingAccountsHandler,
  updateSaasBillingAccountHandler,
} from './platform-billing.controller';
import {
  createSaasInvoiceHandler,
  getSaasInvoiceHandler,
  issueSaasInvoiceHandler,
  listSaasInvoicesHandler,
  voidSaasInvoiceHandler,
} from './platform-billing.controller';

/**
 * CR-BE-SAAS-01 PART 06 — SaaS Billing Account & Invoice endpoints
 * (SaaS Control Plane).
 *
 * Canonical namespace (frozen contract §22 — the ENTIRE PART 06
 * platform surface; no other route is invented):
 *
 *   Reads (`platform.billing.read`):
 *     GET /platform/billing-accounts
 *     GET /platform/billing-accounts/:id
 *     GET /platform/invoices (filters: customerId, status, periodStart/End)
 *     GET /platform/invoices/:id (with lines)
 *   Management (`platform.billing.manage`):
 *     POST /platform/billing-accounts (Idempotency-Key required)
 *     PATCH /platform/billing-accounts/:id (expectedVersion required)
 *     POST /platform/invoices (Idem.; DRAFT or draft+issue)
 *     POST /platform/invoices/:id/issue (Idem. + expectedVersion)
 *     POST /platform/invoices/:id/void (expectedVersion + reason)
 *
 * NOT in PART 06 (frozen): payment/reconciliation routes (PART 07),
 * dunning/overdue sweep (PART 08), usage metering (PART 09),
 * adjustments (no frozen command yet). There is NO generic status
 * PATCH — the lifecycle is command-only (frozen §14.4).
 *
 * Plane boundary: default deny via requirePlatformPermission
 * (platform.* namespace asserted at registration; RBAC default-deny per
 * request); billing permissions never grant business-plane mutations
 * (frozen §8.2).
 */
export function createPlatformBillingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  // Billing accounts
  router.get(
    '/platform/billing-accounts',
    auth,
    requirePlatformPermission('platform.billing.read'),
    listSaasBillingAccountsHandler,
  );
  router.post(
    '/platform/billing-accounts',
    auth,
    requirePlatformPermission('platform.billing.manage'),
    createSaasBillingAccountHandler,
  );
  router.get(
    '/platform/billing-accounts/:id',
    auth,
    requirePlatformPermission('platform.billing.read'),
    getSaasBillingAccountHandler,
  );
  router.patch(
    '/platform/billing-accounts/:id',
    auth,
    requirePlatformPermission('platform.billing.manage'),
    updateSaasBillingAccountHandler,
  );

  // Invoices
  router.get(
    '/platform/invoices',
    auth,
    requirePlatformPermission('platform.billing.read'),
    listSaasInvoicesHandler,
  );
  router.post(
    '/platform/invoices',
    auth,
    requirePlatformPermission('platform.billing.manage'),
    createSaasInvoiceHandler,
  );
  router.get(
    '/platform/invoices/:id',
    auth,
    requirePlatformPermission('platform.billing.read'),
    getSaasInvoiceHandler,
  );
  router.post(
    '/platform/invoices/:id/issue',
    auth,
    requirePlatformPermission('platform.billing.manage'),
    issueSaasInvoiceHandler,
  );
  router.post(
    '/platform/invoices/:id/void',
    auth,
    requirePlatformPermission('platform.billing.manage'),
    voidSaasInvoiceHandler,
  );

  return router;
}
