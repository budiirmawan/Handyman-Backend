/**
 * CR-BE-SAAS-01 PART 08 — Lifecycle HTTP routes (frozen §22).
 *
 * Adds:
 *   POST /platform/subscriptions/:id/reactivate (platform.subscription.manage)
 *     - §11.5 explicit reactivation command, Idempotency-Key required.
 *   POST /platform/subscriptions/:id/sweep-billing (platform.subscription.manage)
 *     - admin/operator seam; not in the public §22 route table but the
 *       route is gated through the canonical `platform.*` permission so
 *       no business-plane mutation becomes reachable from here.
 *   POST /platform/subscriptions/sweep-billing (platform.subscription.manage)
 *     - bulk sweep seam for the future scheduler.
 *
 * No `force-unsuspend` / `reset-overdue` / `clear-grace` style routes are
 * introduced (per task brief — no speculative endpoints).
 */
import { Router } from 'express';
import { authenticationMiddleware } from '../../auth/authentication.middleware';
import { requirePlatformPermission } from '../../platform-iam';
import {
  reactivateSaasSubscriptionHandler,
  sweepAllSubscriptionsLifecycleHandler,
  sweepSubscriptionLifecycleHandler,
} from './saas-lifecycle.controller';

export function createSaasLifecycleRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.post(
    '/platform/subscriptions/:id/reactivate',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    reactivateSaasSubscriptionHandler,
  );

  router.post(
    '/platform/subscriptions/:id/sweep-billing',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    sweepSubscriptionLifecycleHandler,
  );

  router.post(
    '/platform/subscriptions/sweep-billing',
    auth,
    requirePlatformPermission('platform.subscription.manage'),
    sweepAllSubscriptionsLifecycleHandler,
  );

  return router;
}
