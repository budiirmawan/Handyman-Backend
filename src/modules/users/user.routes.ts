import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createUserHandler,
  deactivateUserHandler,
  getUserHandler,
  reactivateUserHandler,
  suspendUserHandler,
  updateUserWhatsAppContactHandler,
} from './user.controller';

/**
 * User identity + account lifecycle endpoints.
 *
 * Protected by RBAC: reading users requires `user.read`; creating users and
 * lifecycle transitions require `user.manage`. Authorization is enforced by
 * the backend — the frontend never becomes the authority.
 */
export function createUserRouter(): Router {
  const router = Router();

  router.post(
    '/users',
    authenticationMiddleware,
    requirePermission('user.manage'),
    createUserHandler,
  );
  router.get(
    '/users/:id',
    authenticationMiddleware,
    requirePermission('user.read'),
    getUserHandler,
  );

  router.post(
    '/users/:id/deactivate',
    authenticationMiddleware,
    requirePermission('user.manage'),
    deactivateUserHandler,
  );
  router.post(
    '/users/:id/suspend',
    authenticationMiddleware,
    requirePermission('user.manage'),
    suspendUserHandler,
  );
  router.post(
    '/users/:id/reactivate',
    authenticationMiddleware,
    requirePermission('user.manage'),
    reactivateUserHandler,
  );

  // CR-BE-NOTIFY-PROV-01 PART 06 — authoritative WhatsApp contact + consent.
  router.patch(
    '/users/:id/whatsapp-contact',
    authenticationMiddleware,
    requirePermission('user.manage'),
    updateUserWhatsAppContactHandler,
  );

  return router;
}
