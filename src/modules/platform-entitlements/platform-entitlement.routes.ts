import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  getSaasEntitlementsHandler,
  overrideSaasEntitlementHandler,
} from './platform-entitlement.controller';

/**
 * CR-BE-SAAS-01 PART 04 — SaaS entitlement endpoints (SaaS Control Plane).
 *
 * Canonical namespace: /platform/subscriptions/:id/entitlements (frozen
 * contract §22 — the ENTIRE PART 04 platform surface; no other route is
 * invented):
 *
 *   Reads (`platform.subscription.read`):
 *     GET /platform/subscriptions/:id/entitlements — resolved
 *       entitlements incl. limits.
 *   Management (`platform.subscription.manage`):
 *     POST /platform/subscriptions/:id/entitlements (expectedVersion
 *       required) — console OVERRIDE (reason mandatory, audited
 *       SAAS_ENTITLEMENT_OVERRIDDEN). PACKAGE-derived grants are NOT
 *       manually editable: only granted/withheld through this command.
 *
 * NOT in PART 04 (frozen §22): add-on attach/detach (excluded add-on
 * commercial behavior), GET /me/entitlements (tenant-side projection,
 * PART 10), and the §12.2 suspension-policy middleware (PART 08).
 *
 * Plane boundary: default deny via requirePlatformPermission
 * (platform.* namespace asserted at registration; RBAC default-deny per
 * request); no building/organization scoping — platform authority is
 * cross-customer by explicit permission grant (frozen §3).
 */
export function createPlatformEntitlementRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/platform/subscriptions/:id/entitlements',
    auth,
    requirePlatformPermission('platform.subscription.read'),
    getSaasEntitlementsHandler,
  );
  router.post(
    '/platform/subscriptions/:id/entitlements',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    overrideSaasEntitlementHandler,
  );

  return router;
}
