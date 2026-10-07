import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getNotificationHandler,
  getNotificationNavigationTargetHandler,
  listNotificationsHandler,
  markNotificationReadHandler,
} from './notification.controller';

/**
 * BE-26A — Notification foundation (in-app inbox).
 *
 *   GET   /notifications
 *   GET   /notifications/:id
 *   PATCH /notifications/:id/read
 *
 * Authenticated, self-scoped reads of the recipient's own notifications.
 * No create endpoint (creation is internal, reacting to operational events)
 * and no push/email/WhatsApp/SMS delivery here.
 *
 * CR-BE-RN21-NOTIFICATION-NAV-01 — backend-owned navigation target:
 *
 *   GET   /notifications/:id/navigation-target
 *
 * Returns the notification's EXPLICIT persisted target resolved for the
 * authenticated recipient, or `{ target: null }`.
 *
 * AUTHORITY — the notification stays self-scoped, and owning it grants no work
 * authority: the resolved assignment must independently satisfy the existing
 * mobile-assignment visibility rules. The route carries `work_order.read`
 * (the Work Order half of the feed's `task.read` + `work_order.read`) and is
 * deliberately NOT gated on `task.read`, so a recipient whose target resolves
 * to no visible assignment still receives `{ target: null }` instead of a
 * misleading 403. Conversely it exposes no task-side read this router did not
 * already serve.
 *
 * Resolving never marks the notification READ.
 */
export function createNotificationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get('/notifications', auth, listNotificationsHandler);
  router.get('/notifications/:id', auth, getNotificationHandler);
  router.patch('/notifications/:id/read', auth, markNotificationReadHandler);
  router.get(
    '/notifications/:id/navigation-target',
    auth,
    requirePermission('work_order.read'),
    getNotificationNavigationTargetHandler,
  );

  return router;
}
