import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  closeSecurityLostFoundHandler,
  createSecurityLostFoundHandler,
  getSecurityLostFoundHandler,
  getSecurityLostFoundHistoryHandler,
  listSecurityLostFoundHandler,
  placeInCustodyHandler,
  registerClaimHandler,
  returnSecurityLostFoundHandler,
  updateSecurityLostFoundHandler,
} from './security-lost-found.controller';

/**
 * BE-12L — Security Lost & Found endpoints.
 *
 *   POST   /security/lost-found
 *   GET    /security/lost-found
 *   GET    /security/lost-found/:id
 *   PATCH  /security/lost-found/:id
 *   POST   /security/lost-found/:id/custody
 *   POST   /security/lost-found/:id/claim
 *   POST   /security/lost-found/:id/return
 *   POST   /security/lost-found/:id/close
 *   GET    /security/lost-found/:id/history
 *
 * Operational Lost & Found custody and traceability only. No
 * inventory / warehouse / procurement / costing / payment / visitor
 * management / reporting dataset logic.
 */
export function createSecurityLostFoundRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('security_lost_found.manage');
  const read = requirePermission('security_lost_found.read');

  router.post(
    '/security/lost-found',
    auth,
    manage,
    createSecurityLostFoundHandler,
  );
  router.get(
    '/security/lost-found',
    auth,
    read,
    listSecurityLostFoundHandler,
  );
  router.get(
    '/security/lost-found/:id',
    auth,
    read,
    getSecurityLostFoundHandler,
  );
  router.patch(
    '/security/lost-found/:id',
    auth,
    manage,
    updateSecurityLostFoundHandler,
  );
  router.post(
    '/security/lost-found/:id/custody',
    auth,
    manage,
    placeInCustodyHandler,
  );
  router.post(
    '/security/lost-found/:id/claim',
    auth,
    manage,
    registerClaimHandler,
  );
  router.post(
    '/security/lost-found/:id/return',
    auth,
    manage,
    returnSecurityLostFoundHandler,
  );
  router.post(
    '/security/lost-found/:id/close',
    auth,
    manage,
    closeSecurityLostFoundHandler,
  );
  router.get(
    '/security/lost-found/:id/history',
    auth,
    read,
    getSecurityLostFoundHistoryHandler,
  );

  return router;
}
