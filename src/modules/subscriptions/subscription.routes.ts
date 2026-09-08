import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSubscriptionHandler,
  getSubscriptionEffectiveStateHandler,
  getSubscriptionHandler,
  listClientSubscriptionsHandler,
  listSubscriptionsHandler,
  updateSubscriptionStatusHandler,
} from './subscription.controller';

/**
 * Subscription management endpoints, protected by RBAC.
 *
 * Reads (`subscription.read`): GET /subscriptions, GET /subscriptions/:id,
 *   GET /subscriptions/:id/effective, GET /clients/:clientId/subscriptions.
 * Management (`subscription.manage`): POST /subscriptions,
 *   PATCH /subscriptions/:id/status.
 */
export function createSubscriptionRouter(): Router {
  const router = Router();

  router.post(
    '/subscriptions',
    authenticationMiddleware,
    requirePermission('subscription.manage'),
    createSubscriptionHandler,
  );
  router.get(
    '/subscriptions',
    authenticationMiddleware,
    requirePermission('subscription.read'),
    listSubscriptionsHandler,
  );
  router.get(
    '/subscriptions/:id',
    authenticationMiddleware,
    requirePermission('subscription.read'),
    getSubscriptionHandler,
  );
  router.get(
    '/subscriptions/:id/effective',
    authenticationMiddleware,
    requirePermission('subscription.read'),
    getSubscriptionEffectiveStateHandler,
  );
  router.patch(
    '/subscriptions/:id/status',
    authenticationMiddleware,
    requirePermission('subscription.manage'),
    updateSubscriptionStatusHandler,
  );

  router.get(
    '/clients/:clientId/subscriptions',
    authenticationMiddleware,
    requirePermission('subscription.read'),
    listClientSubscriptionsHandler,
  );

  return router;
}
