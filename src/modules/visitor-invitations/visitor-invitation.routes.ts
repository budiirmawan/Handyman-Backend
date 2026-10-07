import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelVisitorInvitationHandler,
  createVisitorInvitationHandler,
  getVisitorInvitationHandler,
  listVisitorInvitationsHandler,
  updateVisitorInvitationHandler,
} from './visitor-invitation.controller';

/**
 * BE-13B — Visitor Invitation endpoints.
 *
 *   POST  /visitor-invitations
 *   GET   /visitor-invitations
 *   GET   /visitor-invitations/:id
 *   PATCH /visitor-invitations/:id
 *   POST  /visitor-invitations/:id/cancel
 *
 * Visit-planning layer only — references the shared BE-13A visitor
 * identity and never duplicates it. Distinct from the BE-01 auth
 * `invitations` module (user-account onboarding). No notifications,
 * no marketing/campaign semantics.
 */
export function createVisitorInvitationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('visitor_invitation.manage');
  const read = requirePermission('visitor_invitation.read');

  router.post(
    '/visitor-invitations',
    auth,
    manage,
    createVisitorInvitationHandler,
  );
  router.get(
    '/visitor-invitations',
    auth,
    read,
    listVisitorInvitationsHandler,
  );
  router.get(
    '/visitor-invitations/:id',
    auth,
    read,
    getVisitorInvitationHandler,
  );
  router.patch(
    '/visitor-invitations/:id',
    auth,
    manage,
    updateVisitorInvitationHandler,
  );
  router.post(
    '/visitor-invitations/:id/cancel',
    auth,
    manage,
    cancelVisitorInvitationHandler,
  );

  return router;
}
