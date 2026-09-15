import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelExpectedVisitorHandler,
  createExpectedVisitorHandler,
  getExpectedVisitorHandler,
  listExpectedVisitorsHandler,
  updateExpectedVisitorHandler,
} from './expected-visitor.controller';

/**
 * BE-13C — Expected Visitor endpoints.
 *
 *   POST  /expected-visitors
 *   GET   /expected-visitors
 *   GET   /expected-visitors/:id
 *   PATCH /expected-visitors/:id
 *   POST  /expected-visitors/:id/cancel
 *
 * Front-desk expectation layer. References the shared BE-13A visitor
 * identity and (optionally) a PENDING BE-13B invitation — never
 * duplicates either. No Walk-In / Check-In / Pass semantics here.
 */
export function createExpectedVisitorRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('expected_visitor.manage');
  const read = requirePermission('expected_visitor.read');

  router.post(
    '/expected-visitors',
    auth,
    manage,
    createExpectedVisitorHandler,
  );
  router.get('/expected-visitors', auth, read, listExpectedVisitorsHandler);
  router.get(
    '/expected-visitors/:id',
    auth,
    read,
    getExpectedVisitorHandler,
  );
  router.patch(
    '/expected-visitors/:id',
    auth,
    manage,
    updateExpectedVisitorHandler,
  );
  router.post(
    '/expected-visitors/:id/cancel',
    auth,
    manage,
    cancelExpectedVisitorHandler,
  );

  return router;
}
