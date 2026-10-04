import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  createHandymanLeadArrivalChallengeHandler,
  getHandymanLeadAssignedScopeHandler,
  listHandymanLeadAssignedScopesHandler,
} from './handyman-lead-assigned-scopes-api.controller';

/**
 * CR-HM-18 BE03 reads plus BE06 Lead arrival-challenge issuance.
 * The POST delegates to the CR-HM-07 challenge service; authorization is
 * the authenticated session user → current CR-HM-04 assignment/crew/current-
 * Lead chain → canAccessClient. No assignment mutation or arrival decision
 * is exposed here, and tenant_company.read is not required.
 */
export function createHandymanLeadAssignedScopesApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  router.post(
    '/handyman/lead/assigned-scopes/:executionScopeId/arrival-challenge',
    auth,
    createHandymanLeadArrivalChallengeHandler,
  );
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
