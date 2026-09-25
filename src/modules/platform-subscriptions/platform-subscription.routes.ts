import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  activateSaasSubscriptionHandler,
  cancelSaasSubscriptionHandler,
  convertSaasSubscriptionHandler,
  createSaasSubscriptionHandler,
  getSaasSubscriptionHandler,
  listSaasSubscriptionsHandler,
  renewSaasSubscriptionHandler,
  terminateSaasSubscriptionHandler,
  updateSaasSubscriptionHandler,
} from './platform-subscription.controller';

/**
 * CR-BE-SAAS-01 PART 03 — SaaS Subscription endpoints (SaaS Control Plane).
 *
 * Canonical namespace: /platform/subscriptions (frozen contract §22).
 *
 * Reads (`platform.subscription.read`):
 *   GET /platform/subscriptions (filters: customerId, status, packageId),
 *   GET /platform/subscriptions/:id (full aggregate + version + bound
 *   commercial reference).
 * Management (`platform.subscription.manage`):
 *   POST /platform/subscriptions (Idempotency-Key required, op key
 *     `saas.subscription.create`) — DRAFT only;
 *   PATCH /platform/subscriptions/:id (expectedVersion required) —
 *     non-status fields only (renewal date, trial end); NO status setter;
 *   POST /platform/subscriptions/:id/activate (Idempotency-Key, op key
 *     `saas.subscription.activate`) — DRAFT→TRIAL | DRAFT→ACTIVE;
 *   POST /platform/subscriptions/:id/convert (Idempotency-Key, op key
 *     `saas.subscription.convert` — derived; §17.2 omits it) — TRIAL→ACTIVE;
 *   POST /platform/subscriptions/:id/renew (expectedVersion) — §11.3;
 *   POST /platform/subscriptions/:id/cancel (expectedVersion, reason) —
 *     CANCELLED (end-of-period or immediate);
 *   POST /platform/subscriptions/:id/terminate (expectedVersion, reason) —
 *     TERMINATED (irreversible).
 *
 * NOT in PART 03 (frozen §27): reactivate (§11.5 / PART 08), entitlements
 * (PART 04), add-ons (excluded), and the §11.4 billing sweep (PART 08).
 *
 * Plane boundary:
 *   - default deny via requirePlatformPermission (platform.* namespace
 *     asserted at registration; RBAC default-deny per request);
 *   - NO building/organization scoping is applied here — platform authority
 *     is cross-customer by explicit permission grant (frozen §3);
 *   - the business-plane /subscriptions surface is untouched and keeps its
 *     own permissions (frozen D9).
 */
export function createPlatformSubscriptionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/platform/subscriptions',
    auth,
    requirePlatformPermission('platform.subscription.read'),
    listSaasSubscriptionsHandler,
  );
  router.post(
    '/platform/subscriptions',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    createSaasSubscriptionHandler,
  );
  router.get(
    '/platform/subscriptions/:id',
    auth,
    requirePlatformPermission('platform.subscription.read'),
    getSaasSubscriptionHandler,
  );
  router.patch(
    '/platform/subscriptions/:id',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    updateSaasSubscriptionHandler,
  );
  router.post(
    '/platform/subscriptions/:id/activate',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    activateSaasSubscriptionHandler,
  );
  router.post(
    '/platform/subscriptions/:id/convert',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    convertSaasSubscriptionHandler,
  );
  router.post(
    '/platform/subscriptions/:id/renew',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    renewSaasSubscriptionHandler,
  );
  router.post(
    '/platform/subscriptions/:id/cancel',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    cancelSaasSubscriptionHandler,
  );
  router.post(
    '/platform/subscriptions/:id/terminate',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    terminateSaasSubscriptionHandler,
  );

  return router;
}
