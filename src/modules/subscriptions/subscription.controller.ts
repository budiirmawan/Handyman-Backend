import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { subscriptionService } from './subscription.service';
import {
  parseCreateSubscriptionBody,
  parseSubscriptionClientIdParam,
  parseSubscriptionIdParam,
  parseUpdateSubscriptionStatusBody,
} from './subscription.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateSubscriptionBody(req.body);
    const subscription = await subscriptionService.createSubscription(input);
    sendSuccess(res, subscription, 201);
  } catch (error) {
    next(error);
  }
}

export async function listSubscriptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawClientId = Array.isArray(req.query.clientId) ? '' : req.query.clientId;
    const clientId =
      typeof rawClientId === 'string' && rawClientId.trim() !== ''
        ? parseSubscriptionClientIdParam(rawClientId)
        : undefined;
    const subscriptions = await subscriptionService.listSubscriptions(clientId);
    sendSuccess(res, subscriptions);
  } catch (error) {
    next(error);
  }
}

export async function getSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSubscriptionIdParam(paramString(req.params.id));
    const subscription = await subscriptionService.getSubscriptionById(id);
    sendSuccess(res, subscription);
  } catch (error) {
    next(error);
  }
}

export async function updateSubscriptionStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSubscriptionIdParam(paramString(req.params.id));
    const input = parseUpdateSubscriptionStatusBody(req.body);
    const subscription = await subscriptionService.updateSubscriptionStatus(id, input);
    sendSuccess(res, subscription);
  } catch (error) {
    next(error);
  }
}

export async function listClientSubscriptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseSubscriptionClientIdParam(paramString(req.params.clientId));
    const subscriptions = await subscriptionService.listSubscriptionsByClientId(clientId);
    sendSuccess(res, subscriptions);
  } catch (error) {
    next(error);
  }
}

export async function getSubscriptionEffectiveStateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseSubscriptionIdParam(paramString(req.params.id));
    const state = await subscriptionService.getSubscriptionEffectiveState(id);
    sendSuccess(res, state);
  } catch (error) {
    next(error);
  }
}
