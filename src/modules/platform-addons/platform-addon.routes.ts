import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  attachSaasAddOnHandler,
  createSaasAddOnHandler,
  detachSaasAddOnHandler,
  listSaasAddOnsHandler,
  updateSaasAddOnHandler,
} from './platform-addon.controller';

/**
 * CR-BE-SAAS-01 PART 13C PART 02 — Add-on HTTP routes
 * (SaaS Control Plane, frozen contract §22).
 *
 * Catalogue (`platform.product.*`):
 *   GET    /platform/add-ons                       — read
 *   POST   /platform/add-ons                       — manage (no OCC, no Idem.)
 *   PATCH  /platform/add-ons/:id                   — manage (no OCC, no Idem.)
 *
 * Subscription binding (`platform.subscription.manage`):
 *   POST   /platform/subscriptions/:id/add-ons     — OCC on subscription (no Idem.)
 *   DELETE /platform/subscriptions/:id/add-ons/:addOnId — OCC on subscription (no Idem.)
 *
 * No Idempotency-Key / no catalogue expectedVersion: these commands
 * are not in the frozen §17.2 idempotency catalog and the catalogue
 * tables are not §17.3 OCC aggregates (frozen §22 explicitly omits
 * them; PART 13C #1 disposition).
 *
 * Plane boundary: default deny via `requirePlatformPermission`; NO
 * building/organization scoping (platform authority is cross-customer
 * by explicit grant, frozen §3).
 */
export function createPlatformAddOnRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/platform/add-ons',
    auth,
    requirePlatformPermission('platform.product.read'),
    listSaasAddOnsHandler,
  );
  router.post(
    '/platform/add-ons',
    auth,
    requirePlatformPermission('platform.product.manage'),
    createSaasAddOnHandler,
  );
  router.patch(
    '/platform/add-ons/:id',
    auth,
    requirePlatformPermission('platform.product.manage'),
    updateSaasAddOnHandler,
  );

  router.post(
    '/platform/subscriptions/:id/add-ons',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    attachSaasAddOnHandler,
  );
  router.delete(
    '/platform/subscriptions/:id/add-ons/:addOnId',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    detachSaasAddOnHandler,
  );

  return router;
}
