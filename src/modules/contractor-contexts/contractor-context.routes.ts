import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getContractorContextHandler,
  listContractorContextsHandler,
  resolveContractorContextHandler,
  validateContractorEligibilityHandler,
} from './contractor-context.controller';

/**
 * BE-20B — read-only operational Contractor contexts projected from existing
 * Tenant/Vendor foundations. No Contractor master or duplicate relationship
 * is created by these endpoints.
 */
export function createContractorContextRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');

  router.post('/contractor-contexts/resolve', auth, read, resolveContractorContextHandler);
  router.post(
    '/contractor-contexts/permit-eligibility',
    auth,
    read,
    validateContractorEligibilityHandler,
  );
  router.get('/contractor-contexts', auth, read, listContractorContextsHandler);
  router.get(
    '/contractor-contexts/:contractorContextType/:contractorContextId',
    auth,
    read,
    getContractorContextHandler,
  );

  return router;
}
