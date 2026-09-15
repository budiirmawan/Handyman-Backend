import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createApplicationSafetyRequirementHandler,
  createPermitSafetyRequirementHandler,
  getPermitSafetyRequirementHandler,
  listApplicationSafetyRequirementsHandler,
  listPermitSafetyRequirementsHandler,
  listSafetyRequirementsHandler,
  resolvePermitSafetyReadinessHandler,
  updatePermitSafetyReadinessHandler,
} from './permit-safety-requirement.controller';

/** BE-20E PTW prerequisites only; this is not a general HSE platform. */
export function createPermitSafetyRequirementRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('permit.read');
  const manage = requirePermission('permit.manage');

  router.post(
    '/permit-applications/:applicationId/safety-requirements',
    auth,
    manage,
    createApplicationSafetyRequirementHandler,
  );
  router.get(
    '/permit-applications/:applicationId/safety-requirements',
    auth,
    read,
    listApplicationSafetyRequirementsHandler,
  );
  router.post(
    '/permits/:permitId/safety-requirements',
    auth,
    manage,
    createPermitSafetyRequirementHandler,
  );
  router.get(
    '/permits/:permitId/safety-requirements',
    auth,
    read,
    listPermitSafetyRequirementsHandler,
  );
  router.get(
    '/permits/:permitId/safety-readiness',
    auth,
    read,
    resolvePermitSafetyReadinessHandler,
  );
  router.get(
    '/safety-requirements',
    auth,
    read,
    listSafetyRequirementsHandler,
  );
  router.patch(
    '/safety-requirements/:id/readiness',
    auth,
    manage,
    updatePermitSafetyReadinessHandler,
  );
  router.get(
    '/safety-requirements/:id',
    auth,
    read,
    getPermitSafetyRequirementHandler,
  );

  return router;
}
