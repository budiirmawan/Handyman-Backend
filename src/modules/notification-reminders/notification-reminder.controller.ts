import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { notificationReminderService } from './notification-reminder.service';
import {
  parseCreateReminderBody,
  parseReminderIdParam,
  parseReminderStatusFilter,
  parseUpdateReminderBody,
} from './notification-reminder.validation';

/**
 * BE-26H — Notification reminder handlers.
 *
 *   POST  /notification-reminders           create a reminder
 *   GET   /notification-reminders           list (optional ?status=)
 *   GET   /notification-reminders/:id       get a reminder
 *   PATCH /notification-reminders/:id       reschedule / update (PENDING only)
 *   POST  /notification-reminders/:id/cancel  cancel a PENDING reminder
 *
 * Platform configuration, RBAC-protected. Dispatching is internal (the
 * `findDueReminders` / `dispatchDueReminders` scheduler seam) — no dispatch
 * endpoint and no scheduler engine is exposed here.
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function createReminderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateReminderBody(req.body ?? {});
    sendSuccess(res, await notificationReminderService.createReminder(input), 201);
  } catch (error) {
    next(error);
  }
}

export async function listRemindersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const status = parseReminderStatusFilter(req.query.status);
    sendSuccess(res, await notificationReminderService.listReminders(status));
  } catch (error) {
    next(error);
  }
}

export async function getReminderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseReminderIdParam(param(req.params.id));
    sendSuccess(res, await notificationReminderService.getReminder(id));
  } catch (error) {
    next(error);
  }
}

export async function updateReminderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseReminderIdParam(param(req.params.id));
    const input = parseUpdateReminderBody(req.body ?? {});
    sendSuccess(res, await notificationReminderService.updateReminder(id, input));
  } catch (error) {
    next(error);
  }
}

export async function cancelReminderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseReminderIdParam(param(req.params.id));
    sendSuccess(res, await notificationReminderService.cancelReminder(id));
  } catch (error) {
    next(error);
  }
}
