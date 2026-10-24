import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { isValidUuid } from '../clients';
import {
  browserPushSubscriptionNotFoundError,
  browserPushSubscriptionService,
} from './browser-push-subscription.service';
import type { RegisterBrowserPushSubscriptionInput } from './browser-push-subscription.types';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — browser push subscription
 * handlers (the BROWSER half of the multi-client contract).
 *
 *   POST   /mobile/push-subscriptions                register / rotate
 *   GET    /mobile/push-subscriptions                list my subscriptions
 *   DELETE /mobile/push-subscriptions/:subscriptionId revoke one
 *   DELETE /mobile/push-subscriptions                revoke all
 *
 * The subscription always belongs to the AUTHENTICATED user (the user id is
 * taken from the session, never from the body) and is self-scoped: a user
 * can only ever see and revoke their OWN registrations. There is no
 * permission code here, exactly like the native token surface: possession of
 * a registration is never authorization.
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

export async function registerBrowserPushSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const input: RegisterBrowserPushSubscriptionInput = {
      deviceId: body.deviceId,
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      userAgent: body.userAgent,
    };
    const registration = await browserPushSubscriptionService.registerBrowserPushSubscription(
      req.auth.userId,
      input,
    );
    sendSuccess(res, registration, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBrowserPushSubscriptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await browserPushSubscriptionService.listBrowserPushSubscriptions(
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function revokeBrowserPushSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = param(req.params.subscriptionId);
    if (!isValidUuid(subscriptionId)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'subscriptionId', message: 'subscriptionId must be a valid UUID.' },
      ]);
    }
    const revoked =
      await browserPushSubscriptionService.revokeBrowserPushSubscription(
        req.auth.userId,
        subscriptionId,
      );
    if (!revoked) {
      throw browserPushSubscriptionNotFoundError(subscriptionId);
    }
    sendSuccess(res, revoked);
  } catch (error) {
    next(error);
  }
}

export async function revokeAllBrowserPushSubscriptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const revokedCount =
      await browserPushSubscriptionService.revokeAllBrowserPushSubscriptions(
        req.auth.userId,
      );
    sendSuccess(res, { revokedCount });
  } catch (error) {
    next(error);
  }
}
