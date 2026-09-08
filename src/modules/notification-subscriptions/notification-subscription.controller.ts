import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { notificationSubscriptionService } from './notification-subscription.service';
import {
  parseCreateSubscriptionBody,
  parseSubscriptionIdParam,
  parseSubscriptionStatusFilter,
  parseUpdateSubscriptionBody,
} from './notification-subscription.validation';

/**
 * BE-26D — Notification event subscription handlers.
 *
 *   POST  /notification-subscriptions           create a subscription
 *   GET   /notification-subscriptions           list (optional ?status=)
 *   GET   /notification-subscriptions/:id       get a subscription
 *   PATCH /notification-subscriptions/:id       update / deactivate
 *
 * Platform configuration, RBAC-protected. Event matching is internal (the
 * `findMatchingSubscriptions` seam for BE-26E) — no delivery endpoint.
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function createNotificationSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateSubscriptionBody(req.body ?? {});
    sendSuccess(
      res,
      await notificationSubscriptionService.createNotificationEventSubscription(input),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listNotificationSubscriptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const status = parseSubscriptionStatusFilter(req.query.status);
    sendSuccess(
      res,
      await notificationSubscriptionService.listNotificationEventSubscriptions(status),
    );
  } catch (error) {
    next(error);
  }
}

export async function getNotificationSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSubscriptionIdParam(param(req.params.id));
    sendSuccess(res, await notificationSubscriptionService.getNotificationEventSubscription(id));
  } catch (error) {
    next(error);
  }
}

export async function updateNotificationSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSubscriptionIdParam(param(req.params.id));
    const input = parseUpdateSubscriptionBody(req.body ?? {});
    sendSuccess(
      res,
      await notificationSubscriptionService.updateNotificationEventSubscription(id, input),
    );
  } catch (error) {
    next(error);
  }
}
