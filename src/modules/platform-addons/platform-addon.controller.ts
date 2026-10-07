import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  attachSaasAddOn,
  createSaasAddOn,
  detachSaasAddOn,
  listSaasAddOns,
  updateSaasAddOn,
} from './platform-addon.service';
import {
  parseAddOnIdParam,
  parseAttachSaasAddOnBody,
  parseCreateSaasAddOnBody,
  parseDetachSaasAddOnBody,
  parseListSaasAddOnFilters,
  parseSubscriptionIdParam,
  parseUpdateSaasAddOnBody,
} from './platform-addon.validation';

/**
 * CR-BE-SAAS-01 PART 13C PART 02 — Add-on HTTP controllers
 * (SaaS Control Plane).
 *
 * Authority: explicit `platform.product.*` permission (catalogue) or
 * `platform.subscription.manage` (binding), enforced by the router.
 * The authenticated platform actor (`req.auth.userId`) is the only
 * authority recorded in canonical audit; no caller-supplied
 * `actorUserId` / `clientId` is accepted.
 *
 * No Idempotency-Key / catalogue expectedVersion (PART 13C #1). Attach
 * / detach require `expectedVersion` against the SUBSCRIPTION
 * aggregate (frozen §22 `ver`), transported in the request body to
 * match the canonical renew / cancel / terminate convention.
 */

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function listSaasAddOnsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseListSaasAddOnFilters(req.query as Record<string, unknown>);
    const records = await listSaasAddOns(filters);
    sendSuccess(res, records, 200);
  } catch (error) {
    next(error);
  }
}

export async function createSaasAddOnHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateSaasAddOnBody(req.body);
    const record = await createSaasAddOn({
      actorUserId: req.auth.userId,
      authority: 'platform.product.manage',
      body: input,
    });
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

export async function updateSaasAddOnHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAddOnIdParam(req.params.id);
    const input = parseUpdateSaasAddOnBody(req.body);
    const record = await updateSaasAddOn({
      actorUserId: req.auth.userId,
      authority: 'platform.product.manage',
      id,
      body: input,
    });
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

export async function attachSaasAddOnHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const body = parseAttachSaasAddOnBody(req.body);
    const result = await attachSaasAddOn({
      actorUserId: req.auth.userId,
      authority: 'platform.subscription.manage',
      body: { ...body, subscriptionId },
    });
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function detachSaasAddOnHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const addOnId = parseAddOnIdParam(req.params.addOnId);
    const { expectedVersion } = parseDetachSaasAddOnBody(req.body);
    const result = await detachSaasAddOn({
      actorUserId: req.auth.userId,
      authority: 'platform.subscription.manage',
      subscriptionId,
      addOnId,
      expectedVersion,
    });
    sendSuccess(res, result, 200);
  } catch (error) {
    next(error);
  }
}
