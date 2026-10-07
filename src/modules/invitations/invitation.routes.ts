import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  acceptInvitationHandler,
  createInvitationHandler,
  revokeInvitationHandler,
} from './invitation.controller';

/**
 * Invitation endpoints.
 *
 * Creation and revocation are administrative (`user.manage`). Acceptance is a
 * public token-based onboarding action — the invitation token authorizes only
 * this action, not an authenticated session.
 */
export function createInvitationRouter(): Router {
  const router = Router();

  router.post(
    '/invitations',
    authenticationMiddleware,
    requirePermission('user.manage'),
    createInvitationHandler,
  );

  router.post('/invitations/accept', acceptInvitationHandler);

  router.post(
    '/invitations/:id/revoke',
    authenticationMiddleware,
    requirePermission('user.manage'),
    revokeInvitationHandler,
  );

  return router;
}
