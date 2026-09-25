/**
 * CR-BE-SAAS-01 PART 11B — Support session HTTP routes (frozen §22).
 *
 * Frozen routes (exactly three):
 *
 *   POST   /api/v1/platform/support-sessions
 *     perm: platform.support.access
 *     no Idempotency-Key (§17.2 — NOT in the frozen op-key catalogue)
 *
 *   GET    /api/v1/platform/support-sessions
 *     perm: platform.support.access
 *
 *   DELETE /api/v1/platform/support-sessions/:id
 *     perm: platform.support.access
 *
 * No PATCH, no /me/support, no impersonation route. The route layer
 * does NOT recompute any business rule — it only enforces namespace
 * (requirePlatformPermission asserts `platform.*`) and delegates to
 * the PART 11A domain service.
 */
import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePlatformPermission } from '../platform-iam';
import {
  listSupportSessionsHandler,
  openSupportSessionHandler,
  revokeSupportSessionHandler,
} from './platform-support-session.controller';

const auth = authenticationMiddleware;

export function createPlatformSupportRouter(): Router {
  const router = Router();

  router.post(
    '/platform/support-sessions',
    auth,
    requirePlatformPermission('platform.support.access'),
    openSupportSessionHandler,
  );
  router.get(
    '/platform/support-sessions',
    auth,
    requirePlatformPermission('platform.support.access'),
    listSupportSessionsHandler,
  );
  router.delete(
    '/platform/support-sessions/:id',
    auth,
    requirePlatformPermission('platform.support.access'),
    revokeSupportSessionHandler,
  );

  return router;
}
