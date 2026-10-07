import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  createSaaSCustomerHandler,
  getSaaSCustomerHandler,
  listSaaSCustomersHandler,
  updateSaaSCustomerHandler,
} from './platform-customer.controller';

/**
 * CR-BE-SAAS-01 PART 01 — SaaS Customer endpoints (SaaS Control Plane).
 *
 * Canonical namespace: /platform/customers (frozen contract §22).
 *
 * Reads (`platform.customer.read`): GET /platform/customers,
 *   GET /platform/customers/:id.
 * Management (`platform.customer.manage`): POST /platform/customers
 *   (Idempotency-Key required), PATCH /platform/customers/:id
 *   (expectedVersion required).
 *
 * Plane boundary:
 *   - default deny via requirePlatformPermission (platform.* namespace
 *     asserted at registration; RBAC default-deny per request);
 *   - NO building/organization scoping is applied here — platform authority
 *     is cross-customer by explicit permission grant (frozen §3);
 *   - the business-plane /clients surface is untouched and keeps its own
 *     permissions.
 */
export function createPlatformCustomerRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/platform/customers',
    auth,
    requirePlatformPermission('platform.customer.read'),
    listSaaSCustomersHandler,
  );
  router.post(
    '/platform/customers',
    auth,
    requirePlatformPermission('platform.customer.manage'),
    createSaaSCustomerHandler,
  );
  router.get(
    '/platform/customers/:id',
    auth,
    requirePlatformPermission('platform.customer.read'),
    getSaaSCustomerHandler,
  );
  router.patch(
    '/platform/customers/:id',
    auth,
    requirePlatformPermission('platform.customer.manage'),
    updateSaaSCustomerHandler,
  );

  return router;
}
