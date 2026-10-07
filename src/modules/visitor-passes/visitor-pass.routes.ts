import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelVisitorPassHandler,
  getVisitorPassHandler,
  issueVisitorPassHandler,
  listVisitorPassesHandler,
  returnVisitorPassHandler,
} from './visitor-pass.controller';

/**
 * BE-13I — Visitor Pass endpoints.
 *
 * Administrative pass lifecycle only. Physical access-control hardware
 * and integrations are intentionally outside this router's scope.
 */
export function createVisitorPassRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('visitor_pass.read');
  const manage = requirePermission('visitor_pass.manage');

  router.post('/visitor-passes', auth, manage, issueVisitorPassHandler);
  router.get('/visitor-passes', auth, read, listVisitorPassesHandler);
  router.get('/visitor-passes/:id', auth, read, getVisitorPassHandler);
  router.post(
    '/visitor-passes/:id/return',
    auth,
    manage,
    returnVisitorPassHandler,
  );
  router.post(
    '/visitor-passes/:id/cancel',
    auth,
    manage,
    cancelVisitorPassHandler,
  );

  return router;
}
