import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getCanonicalIdentityHandler,
  getDispatchReadinessHandler,
  getDispatchReleaseHandler,
  postDispatchCancelHandler,
  postDispatchReleaseHandler,
} from './handyman-dispatch-api.controller';

/**
 * CR-HM-OPS-DISPATCH-02 P0-C/P0-D — Dispatch readiness/release + canonical
 * identity projection HTTP surface.
 *
 *   GET  /handyman/execution-scopes/:executionScopeId/dispatch/readiness
 *   POST /handyman/execution-scopes/:executionScopeId/dispatch/release
 *   GET  /handyman/execution-scopes/:executionScopeId/dispatch/release
 *   POST /handyman/execution-scopes/:executionScopeId/dispatch/cancel
 *   GET  /handyman/requests/:handymanRequestId/canonical-identity
 */
export function createHandymanDispatchApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  const base = '/handyman/execution-scopes/:executionScopeId/dispatch';
  router.get(`${base}/readiness`, auth, read, getDispatchReadinessHandler);
  router.post(`${base}/release`, auth, manage, postDispatchReleaseHandler);
  router.get(`${base}/release`, auth, read, getDispatchReleaseHandler);
  router.post(`${base}/cancel`, auth, manage, postDispatchCancelHandler);

  router.get(
    '/handyman/requests/:handymanRequestId/canonical-identity',
    auth,
    read,
    getCanonicalIdentityHandler,
  );
  return router;
}
