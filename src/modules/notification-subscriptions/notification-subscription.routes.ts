import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createNotificationSubscriptionHandler,
  getNotificationSubscriptionHandler,
  listNotificationSubscriptionsHandler,
  updateNotificationSubscriptionHandler,
} from './notification-subscription.controller';

/**
 * BE-26D — Notification event subscription foundation (platform configuration).
 *
 *   POST  /notification-subscriptions
 *   GET   /notification-subscriptions
 *   GET   /notification-subscriptions/:id
 *   PATCH /notification-subscriptions/:id
 *
 * RBAC-protected (default-deny): reads require `notification_subscription.read`,
 * writes require `notification_subscription.manage`. No delivery / matching
 * endpoint is exposed (event mapping is internal for BE-26E).
 */
export function createNotificationSubscriptionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('notification_subscription.read');
  const manage = requirePermission('notification_subscription.manage');

  router.post('/notification-subscriptions', auth, manage, createNotificationSubscriptionHandler);
  router.get('/notification-subscriptions', auth, read, listNotificationSubscriptionsHandler);
  router.get('/notification-subscriptions/:id', auth, read, getNotificationSubscriptionHandler);
  router.patch('/notification-subscriptions/:id', auth, manage, updateNotificationSubscriptionHandler);

  return router;
}
