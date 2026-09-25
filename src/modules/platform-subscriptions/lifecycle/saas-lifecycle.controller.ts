/**
 * CR-BE-SAAS-01 PART 08 — Lifecycle HTTP controller (frozen §22).
 *
 * Routes:
 *   POST /api/v1/platform/subscriptions/:id/reactivate
 *   POST /api/v1/platform/subscriptions/:id/sweep-billing
 *   POST /api/v1/platform/subscriptions/sweep-billing       (bulk)
 *
 * Reactivation is the PART 08 endpoint explicitly added to §22.
 * Sweep routes are admin/operator seams — they are NOT in the frozen §22
 * public route table; they exist only as callable service seams. We
 * still register them so the focused tests (and a future scheduler)
 * can drive the deterministic transition graph. They require the
 * `platform.subscription.manage` permission (same authority PART 03
 * uses for cancel/terminate), and the body MUST include a
 * `expectedVersion` for the per-subscription sweep.
 */
import type { NextFunction, Request, Response } from 'express';
import { parseIdempotencyKeyRequired } from '../../request-idempotency';
import { AppError } from '../../../shared/errors';
import { sendSuccess } from '../../../shared/api-response';
import {
  reactivateSaasSubscription,
  sweepAllSubscriptionsLifecycle,
  sweepSubscriptionLifecycle,
  suspendSubscriptionViaSweep,
} from './saas-lifecycle.service';
import { platformSubscriptionRepository } from '../platform-subscription.repository';

function ensureActor(req: Request): string {
  const auth = (req as unknown as { auth?: { userId?: string } }).auth;
  const actor = auth?.userId;
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new AppError({
      code: 'UNAUTHENTICATED' as never,
      message: 'Authentication required.',
      statusCode: 401,
    });
  }
  return actor;
}

function ensureUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
  return value;
}

function ensureSubscriptionId(req: Request): string {
  const raw = req.params['id'];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'id is required.' },
    ]);
  }
  return ensureUuid(raw, 'id');
}

export async function reactivateSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = ensureSubscriptionId(req);
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedVersion = body['expectedVersion'];
    if (
      typeof expectedVersion !== 'number' ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      throw AppError.validation('Request validation failed.', [
        { field: 'expectedVersion', message: 'expectedVersion must be a positive integer.' },
      ]);
    }
    const overrideReasonRaw = body['overrideReason'];
    let overrideReason: string | undefined;
    if (overrideReasonRaw !== undefined) {
      if (typeof overrideReasonRaw !== 'string') {
        throw AppError.validation('Request validation failed.', [
          { field: 'overrideReason', message: 'overrideReason must be a string when supplied.' },
        ]);
      }
      const trimmed = overrideReasonRaw.trim();
      if (trimmed.length > 0) overrideReason = trimmed;
    }
    const actorUserId = ensureActor(req);
    const authority = `platform.user:${actorUserId}`;
    const out = await reactivateSaasSubscription(
      actorUserId,
      authority,
      subscriptionId,
      { expectedVersion, overrideReason },
      idempotencyKey,
    );
    sendSuccess(res, out);
  } catch (error) {
    next(error);
  }
}

export async function sweepSubscriptionLifecycleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = ensureSubscriptionId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedVersion = body['expectedVersion'];
    if (
      typeof expectedVersion !== 'number' ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      throw AppError.validation('Request validation failed.', [
        { field: 'expectedVersion', message: 'expectedVersion must be a positive integer.' },
      ]);
    }
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    if (reason.length === 0) {
      throw AppError.validation('Request validation failed.', [
        { field: 'reason', message: 'reason is required.' },
      ]);
    }
    const actorUserId = ensureActor(req);
    const authority = `platform.user:${actorUserId}`;
    const sub = await platformSubscriptionRepository.findById(subscriptionId);
    if (!sub) {
      throw new AppError({
        code: 'SAAS_SUBSCRIPTION_NOT_FOUND' as never,
        message: 'SaaS subscription not found.',
        statusCode: 404,
      });
    }
    // For PAST_DUE → SUSPENDED direct path the operator must use the
    // dedicated command; otherwise we run the full sweep.
    if (
      sub.status === 'PAST_DUE' &&
      typeof body['forceSuspend'] === 'boolean' &&
      body['forceSuspend'] === true
    ) {
      const out = await suspendSubscriptionViaSweep(actorUserId, authority, {
        subscriptionId,
        expectedVersion,
        reason,
      });
      sendSuccess(res, { subscription: out });
      return;
    }
    const cutoff = typeof body['cutoff'] === 'string' ? new Date(body['cutoff']) : new Date();
    const out = await sweepSubscriptionLifecycle(actorUserId, authority, subscriptionId, {
      cutoff,
    });
    sendSuccess(res, out);
  } catch (error) {
    next(error);
  }
}

export async function sweepAllSubscriptionsLifecycleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cutoff = typeof body['cutoff'] === 'string' ? new Date(body['cutoff']) : new Date();
    const limit = typeof body['limit'] === 'number' ? body['limit'] : 200;
    const actorUserId = ensureActor(req);
    const authority = `platform.user:${actorUserId}`;
    const out = await sweepAllSubscriptionsLifecycle(actorUserId, authority, { cutoff, limit });
    sendSuccess(res, out);
  } catch (error) {
    next(error);
  }
}
