import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSecurityKeyHandler,
  getCurrentCustodyHandler,
  getCustodyHistoryHandler,
  getSecurityKeyHandler,
  issueSecurityKeyHandler,
  listSecurityKeysHandler,
  markKeyLostHandler,
  returnSecurityKeyHandler,
  updateSecurityKeyHandler,
} from './security-key.controller';

/**
 * BE-12K — Security Key Control endpoints.
 *
 *   POST   /security/keys
 *   GET    /security/keys
 *   GET    /security/keys/:id
 *   PATCH  /security/keys/:id
 *   POST   /security/keys/:id/issue
 *   POST   /security/keys/:id/return
 *   POST   /security/keys/:id/mark-lost
 *   GET    /security/keys/:id/custody
 *   GET    /security/keys/:id/history
 *
 * Operational key custody and traceability only. No inventory /
 * warehouse / procurement / costing / supplier logic. No electronic
 * access-control or smart-lock integration. No Lost & Found logic.
 */
export function createSecurityKeyRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('security_key.manage');
  const read = requirePermission('security_key.read');

  router.post('/security/keys', auth, manage, createSecurityKeyHandler);
  router.get('/security/keys', auth, read, listSecurityKeysHandler);
  router.get('/security/keys/:id', auth, read, getSecurityKeyHandler);
  router.patch('/security/keys/:id', auth, manage, updateSecurityKeyHandler);
  router.post(
    '/security/keys/:id/issue',
    auth,
    manage,
    issueSecurityKeyHandler,
  );
  router.post(
    '/security/keys/:id/return',
    auth,
    manage,
    returnSecurityKeyHandler,
  );
  router.post(
    '/security/keys/:id/mark-lost',
    auth,
    manage,
    markKeyLostHandler,
  );
  router.get(
    '/security/keys/:id/custody',
    auth,
    read,
    getCurrentCustodyHandler,
  );
  router.get(
    '/security/keys/:id/history',
    auth,
    read,
    getCustodyHistoryHandler,
  );

  return router;
}
