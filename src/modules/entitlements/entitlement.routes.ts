import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createEntitlementHandler,
  getEntitlementHandler,
  listEntitlementsHandler,
  listSubscriptionEntitlementsHandler,
  resolveEffectiveEntitlementsHandler,
  updateEntitlementStatusHandler,
} from './entitlement.controller';

/**
 * Module Entitlement management endpoints, protected by RBAC.
 *
 * Reads (`entitlement.read`): GET /entitlements, GET /entitlements/:id,
 *   GET /subscriptions/:subscriptionId/entitlements,
 *   GET /subscriptions/:subscriptionId/entitlements/effective.
 * Management (`entitlement.manage`): POST /subscriptions/:subscriptionId/entitlements,
 *   PATCH /entitlements/:id/status.
 */
export function createEntitlementRouter(): Router {
  const router = Router();

  router.post(
    '/subscriptions/:subscriptionId/entitlements',
    authenticationMiddleware,
    requirePermission('entitlement.manage'),
    createEntitlementHandler,
  );
  router.get(
    '/subscriptions/:subscriptionId/entitlements',
    authenticationMiddleware,
    requirePermission('entitlement.read'),
    listSubscriptionEntitlementsHandler,
  );
  router.get(
    '/subscriptions/:subscriptionId/entitlements/effective',
    authenticationMiddleware,
    requirePermission('entitlement.read'),
    resolveEffectiveEntitlementsHandler,
  );
  router.get(
    '/entitlements',
    authenticationMiddleware,
    requirePermission('entitlement.read'),
    listEntitlementsHandler,
  );
  router.get(
    '/entitlements/:id',
    authenticationMiddleware,
    requirePermission('entitlement.read'),
    getEntitlementHandler,
  );
  router.patch(
    '/entitlements/:id/status',
    authenticationMiddleware,
    requirePermission('entitlement.manage'),
    updateEntitlementStatusHandler,
  );

  return router;
}
