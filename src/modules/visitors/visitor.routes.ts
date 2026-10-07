import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVisitorHandler,
  getVisitorHandler,
  listVisitorsHandler,
  updateVisitorHandler,
} from './visitor.controller';

/**
 * BE-13A — Visitor Identity / Registration endpoints.
 *
 *   POST  /clients/:clientId/visitors
 *   GET   /clients/:clientId/visitors
 *   GET   /visitors/:id
 *   PATCH /visitors/:id
 *
 * The Visitor is the single shared identity master of the BE-13 Front
 * Desk domain — Invitation, Walk-In, Contractor and Delivery / Courier
 * contexts all reference this identity. No delete endpoint: identities
 * are deactivated (INACTIVE) or blocked (BLOCKED), never destroyed,
 * because later Visit records must keep a valid identity reference.
 */
export function createVisitorRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('visitor.manage');
  const read = requirePermission('visitor.read');

  router.post(
    '/clients/:clientId/visitors',
    auth,
    manage,
    createVisitorHandler,
  );
  router.get('/clients/:clientId/visitors', auth, read, listVisitorsHandler);
  router.get('/visitors/:id', auth, read, getVisitorHandler);
  router.patch('/visitors/:id', auth, manage, updateVisitorHandler);

  return router;
}
