import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelReminderHandler,
  createReminderHandler,
  getReminderHandler,
  listRemindersHandler,
  updateReminderHandler,
} from './notification-reminder.controller';

/**
 * BE-26H — Notification reminder foundation (platform configuration).
 *
 *   POST  /notification-reminders
 *   GET   /notification-reminders
 *   GET   /notification-reminders/:id
 *   PATCH /notification-reminders/:id
 *   POST  /notification-reminders/:id/cancel
 *
 * RBAC-protected (default-deny): reads require `notification_reminder.read`,
 * writes require `notification_reminder.manage`. No dispatch endpoint and no
 * scheduler engine is exposed.
 */
export function createNotificationReminderRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('notification_reminder.read');
  const manage = requirePermission('notification_reminder.manage');

  router.post('/notification-reminders', auth, manage, createReminderHandler);
  router.get('/notification-reminders', auth, read, listRemindersHandler);
  router.get('/notification-reminders/:id', auth, read, getReminderHandler);
  router.patch('/notification-reminders/:id', auth, manage, updateReminderHandler);
  router.post('/notification-reminders/:id/cancel', auth, manage, cancelReminderHandler);

  return router;
}
