import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  acceptInvitationHandler,
  createInvitationHandler,
  getInvitationHandler,
  listInvitationsHandler,
  revokeInvitationHandler,
  validateInvitationHandler,
} from './invitation.controller';

/**
 * Invitation endpoints.
 *
 * Administrative surfaces (create/list/get/revoke) require `user.manage`.
 *
 * Public surfaces (accept, validate) are token-based onboarding actions:
 *   - POST /invitations/validate — unauthenticated pre-flight status check
 *     (so the acceptance UI can show "expired/revoked" before the candidate
 *     types a password). Returns a generic 404 for unknown tokens.
 *   - POST /invitations/accept   — consumes the one-time token, creates the
 *     user + credential, and marks the invitation ACCEPTED atomically.
 *
 * The raw invitation token is returned EXACTLY ONCE at creation and never
 * persisted in plaintext; only its SHA-256 hash is stored.
 */
export function createInvitationRouter(): Router {
  const router = Router();

  router.post(
    '/invitations',
    authenticationMiddleware,
    requirePermission('user.manage'),
    createInvitationHandler,
  );

  router.get(
    '/invitations',
    authenticationMiddleware,
    requirePermission('user.manage'),
    listInvitationsHandler,
  );

  router.get(
    '/invitations/:id',
    authenticationMiddleware,
    requirePermission('user.manage'),
    getInvitationHandler,
  );

  // Public (token-based) — no session, no RBAC. The token authorizes only
  // this one validation call.
  router.post('/invitations/validate', validateInvitationHandler);
  router.post('/invitations/accept', acceptInvitationHandler);

  router.post(
    '/invitations/:id/revoke',
    authenticationMiddleware,
    requirePermission('user.manage'),
    revokeInvitationHandler,
  );

  return router;
}
