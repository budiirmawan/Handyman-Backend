import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createNotificationTemplateHandler,
  getNotificationTemplateHandler,
  listNotificationTemplatesHandler,
  updateNotificationTemplateHandler,
} from './notification-template.controller';

/**
 * BE-26B — Notification template foundation (platform configuration).
 *
 *   POST  /notification-templates
 *   GET   /notification-templates
 *   GET   /notification-templates/:id
 *   PATCH /notification-templates/:id
 *
 * RBAC-protected (default-deny): reads require `notification_template.read`,
 * writes require `notification_template.manage`. No render / send / recipient
 * endpoints exist yet (BE-26C/D).
 */
export function createNotificationTemplateRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('notification_template.read');
  const manage = requirePermission('notification_template.manage');

  router.post('/notification-templates', auth, manage, createNotificationTemplateHandler);
  router.get('/notification-templates', auth, read, listNotificationTemplatesHandler);
  router.get('/notification-templates/:id', auth, read, getNotificationTemplateHandler);
  router.patch('/notification-templates/:id', auth, manage, updateNotificationTemplateHandler);

  return router;
}
