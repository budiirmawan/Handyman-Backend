import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getBastByIdHandler,
  getExecutionScopeBastHandler,
  postBastAcceptHandler,
  postBastRejectHandler,
  postBastSignOffHandler,
} from './handyman-bast-api.controller';

/**
 * CR-HM-17 GAP PART 04 — CR-HM-11 BAST HTTP surface:
 *
 *   GET  /handyman/execution-scopes/:executionScopeId/bast
 *   GET  /handyman/bast/:bastId
 *   POST /handyman/bast/:bastId/accept
 *   POST /handyman/bast/:bastId/reject
 *   POST /handyman/bast/:bastId/sign-off
 *
 * Reads require `tenant_company.read` + `canAccessClient`.
 * Customer sign-off requires `tenant_company.manage` + `canAccessClient`.
 * Worker/provider BAST commands (`prepare`, `issue`, `void`) are NOT exposed.
 */
export function createHandymanBastApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  router.get(
    '/handyman/execution-scopes/:executionScopeId/bast',
    auth,
    read,
    getExecutionScopeBastHandler,
  );
  router.get(
    '/handyman/bast/:bastId',
    auth,
    read,
    getBastByIdHandler,
  );
  router.post(
    '/handyman/bast/:bastId/accept',
    auth,
    manage,
    postBastAcceptHandler,
  );
  router.post(
    '/handyman/bast/:bastId/reject',
    auth,
    manage,
    postBastRejectHandler,
  );
  router.post(
    '/handyman/bast/:bastId/sign-off',
    auth,
    manage,
    postBastSignOffHandler,
  );

  return router;
}
