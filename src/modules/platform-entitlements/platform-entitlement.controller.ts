import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import {
  getSaasEntitlements,
  overrideSaasEntitlement,
} from './platform-entitlement.service';
import { parseOverrideSaasEntitlementBody } from './platform-entitlement.validation';

/** Express 5 types path params as `string | string[]`; normalize. */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

function parseSubscriptionIdParam(raw: string): string {
  const value = raw?.trim();
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw AppError.validation('Request validation failed.', [
      { field: 'subscriptionId', message: 'subscriptionId must be a UUID.' },
    ]);
  }
  return value;
}

/** GET /platform/subscriptions/:id/entitlements (platform.subscription.read). */
export async function getSaasEntitlementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const resolved = await getSaasEntitlements(subscriptionId);
    sendSuccess(res, resolved);
  } catch (error) {
    next(error);
  }
}

/** POST /platform/subscriptions/:id/entitlements (platform.subscription.manage, ver). */
export async function overrideSaasEntitlementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const input = parseOverrideSaasEntitlementBody(req.body);

    const result = await overrideSaasEntitlement(
      req.auth.userId,
      'platform.subscription.manage',
      subscriptionId,
      input,
    );

    sendSuccess(res, {
      entitlement: result.entitlement,
      version: result.version,
      changed: result.changed,
    });
  } catch (error) {
    next(error);
  }
}
