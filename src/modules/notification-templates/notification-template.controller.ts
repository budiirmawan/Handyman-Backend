import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { notificationTemplateService } from './notification-template.service';
import {
  parseCreateNotificationTemplateBody,
  parseNotificationTemplateIdParam,
  parseNotificationTemplateStatusFilter,
  parseUpdateNotificationTemplateBody,
} from './notification-template.validation';

/**
 * BE-26B — Notification template handlers.
 *
 *   POST  /notification-templates           create a template
 *   GET   /notification-templates           list templates (optional ?status=)
 *   GET   /notification-templates/:id       get a template
 *   PATCH /notification-templates/:id       update / deactivate a template
 *
 * Platform configuration, protected by RBAC (notification_template.read /
 * notification_template.manage). Rendering is internal — no render endpoint.
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function createNotificationTemplateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateNotificationTemplateBody(req.body ?? {});
    sendSuccess(
      res,
      await notificationTemplateService.createNotificationTemplate(input),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listNotificationTemplatesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const status = parseNotificationTemplateStatusFilter(req.query.status);
    sendSuccess(res, await notificationTemplateService.listNotificationTemplates(status));
  } catch (error) {
    next(error);
  }
}

export async function getNotificationTemplateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseNotificationTemplateIdParam(param(req.params.id));
    sendSuccess(res, await notificationTemplateService.getNotificationTemplate(id));
  } catch (error) {
    next(error);
  }
}

export async function updateNotificationTemplateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseNotificationTemplateIdParam(param(req.params.id));
    const input = parseUpdateNotificationTemplateBody(req.body ?? {});
    sendSuccess(
      res,
      await notificationTemplateService.updateNotificationTemplate(id, input),
    );
  } catch (error) {
    next(error);
  }
}
