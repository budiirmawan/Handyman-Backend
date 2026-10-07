import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelEscalationHandler,
  createEscalationHandler,
  getEscalationHandler,
  listEscalationsHandler,
  updateEscalationHandler,
} from './notification-escalation.controller';

/**
 * BE-26I — Notification escalation foundation (platform configuration).
 *
 *   POST  /notification-escalations
 *   GET   /notification-escalations
 *   GET   /notification-escalations/:id
 *   PATCH /notification-escalations/:id
 *   POST  /notification-escalations/:id/cancel
 *
 * RBAC-protected (default-deny): reads require `notification_escalation.read`,
 * writes require `notification_escalation.manage`. No trigger endpoint and no
 * scheduler engine is exposed.
 */
export function createNotificationEscalationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('notification_escalation.read');
  const manage = requirePermission('notification_escalation.manage');

  router.post('/notification-escalations', auth, manage, createEscalationHandler);
  router.get('/notification-escalations', auth, read, listEscalationsHandler);
  router.get('/notification-escalations/:id', auth, read, getEscalationHandler);
  router.patch('/notification-escalations/:id', auth, manage, updateEscalationHandler);
  router.post('/notification-escalations/:id/cancel', auth, manage, cancelEscalationHandler);

  return router;
}
