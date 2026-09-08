import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  getNotificationHandler,
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
 */
export function createNotificationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get('/notifications', auth, listNotificationsHandler);
  router.get('/notifications/:id', auth, getNotificationHandler);
  router.patch('/notifications/:id/read', auth, markNotificationReadHandler);

  return router;
}
