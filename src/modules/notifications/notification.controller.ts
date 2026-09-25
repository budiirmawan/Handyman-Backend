import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { notificationNavigationService } from './notification-navigation.service';
import { notificationService } from './notification.service';
import {
  parseNotificationFilters,
  parseNotificationIdParam,
} from './notification.validation';

/**
 * BE-26A — Notification handlers.
 *
 *   GET   /notifications            list the authenticated user's inbox
 *   GET   /notifications/:id        get the authenticated user's notification
 *   PATCH /notifications/:id/read   mark the authenticated user's notification READ
 *
 * Self-scoped (the recipient is always the authenticated user, never
 * client-supplied) — the same isolation model as BE-25L push tokens. There is
 * no create/update/delete endpoint: creation is internal to the backend.
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function listNotificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.auth.userId;
    const filters = parseNotificationFilters(req.query);

    if (hasPaginationParams(req.query)) {
      const pg = parsePagination(req.query);
      const total = await notificationService.countNotifications(userId, filters);
      const items = await notificationService.listNotifications(
        userId,
        filters,
        pg.limit,
        pg.offset,
      );
      sendSuccess(
        res,
        items,
        200,
        buildPaginationMeta(pg.page, pg.pageSize, total),
      );
      return;
    }

    sendSuccess(res, await notificationService.listNotifications(userId, filters));
  } catch (error) {
    next(error);
  }
}

export async function getNotificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseNotificationIdParam(param(req.params.id));
    sendSuccess(
      res,
      await notificationService.getNotification(req.auth.userId, id),
    );
  } catch (error) {
    next(error);
  }
}

export async function markNotificationReadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseNotificationIdParam(param(req.params.id));
    sendSuccess(
      res,
      await notificationService.markNotificationRead(req.auth.userId, id),
    );
  } catch (error) {
    next(error);
  }
}

/**
 * CR-BE-RN21-NOTIFICATION-NAV-01 — navigation target handler.
 *
 *   GET /notifications/:id/navigation-target   →  { target: {...} | null }
 *
 * The recipient is always the authenticated user (never client-supplied), the
 * notification is resolved through the same recipient-scoped detail read, and
 * the returned assignment is resolved through the existing mobile-assignment
 * authority. Resolving reads state only: the notification is NOT marked read
 * here — that remains the explicit `PATCH /notifications/:id/read` call.
 */
export async function getNotificationNavigationTargetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseNotificationIdParam(param(req.params.id));
    sendSuccess(
      res,
      await notificationNavigationService.resolveNotificationNavigationTarget(
        req.auth.userId,
        id,
      ),
    );
  } catch (error) {
    next(error);
  }
}
