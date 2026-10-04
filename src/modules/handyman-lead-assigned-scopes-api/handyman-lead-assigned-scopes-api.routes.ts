import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  getHandymanLeadAssignedScopeHandler,
  listHandymanLeadAssignedScopesHandler,
} from './handyman-lead-assigned-scopes-api.controller';

/**
 * CR-HM-18 BE03 — the two frozen Lead assigned-scope reads only.
 * Authorization is the authenticated session user → current CR-HM-04
 * assignment/crew/current-Lead chain → canAccessClient. These routes do not
 * use tenant_company.read and expose no unassigned browse, claim, mutation,
 * readiness-history, or Admin/Dispatcher surface.
 */
export function createHandymanLeadAssignedScopesApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.get(
    '/handyman/lead/assigned-scopes',
    auth,
    listHandymanLeadAssignedScopesHandler,
  );
  router.get(
    '/handyman/lead/assigned-scopes/:executionScopeId',
    auth,
    getHandymanLeadAssignedScopeHandler,
  );

  return router;
}
