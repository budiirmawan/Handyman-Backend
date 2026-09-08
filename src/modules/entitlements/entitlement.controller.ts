import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { entitlementService } from './entitlement.service';
import {
  parseCreateEntitlementBody,
  parseEntitlementIdParam,
  parseEntitlementSubscriptionIdParam,
  parseUpdateEntitlementStatusBody,
} from './entitlement.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createEntitlementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseEntitlementSubscriptionIdParam(
      paramString(req.params.subscriptionId),
    );
    const input = parseCreateEntitlementBody(req.body);
    const entitlement = await entitlementService.createEntitlement(subscriptionId, input);
    sendSuccess(res, entitlement, 201);
  } catch (error) {
    next(error);
  }
}

export async function listSubscriptionEntitlementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseEntitlementSubscriptionIdParam(
      paramString(req.params.subscriptionId),
    );
    const entitlements =
      await entitlementService.listEntitlementsBySubscriptionId(subscriptionId);
    sendSuccess(res, entitlements);
  } catch (error) {
    next(error);
  }
}

export async function listEntitlementsHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const entitlements = await entitlementService.listEntitlements();
    sendSuccess(res, entitlements);
  } catch (error) {
    next(error);
  }
}

export async function getEntitlementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseEntitlementIdParam(paramString(req.params.id));
    const entitlement = await entitlementService.getEntitlementById(id);
    sendSuccess(res, entitlement);
  } catch (error) {
    next(error);
  }
}

export async function updateEntitlementStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseEntitlementIdParam(paramString(req.params.id));
    const input = parseUpdateEntitlementStatusBody(req.body);
    const entitlement = await entitlementService.updateEntitlementStatus(id, input);
    sendSuccess(res, entitlement);
  } catch (error) {
    next(error);
  }
}

export async function resolveEffectiveEntitlementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseEntitlementSubscriptionIdParam(
      paramString(req.params.subscriptionId),
    );
    const effective =
      await entitlementService.resolveEffectiveEntitlements(subscriptionId);
    sendSuccess(res, effective);
  } catch (error) {
    next(error);
  }
}
