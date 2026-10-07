import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createRequirementHandler,
  getEvidenceHandler,
  listEvidenceByFiltersHandler,
  listEvidenceHandler,
  listRequirementsHandler,
  readinessHandler,
  removeEvidenceHandler,
  submitEvidenceHandler,
} from './permit-evidence.controller';

/** BE-20J adapter over BE-07 Evidence Requirement/Submission tables. */
export function createPermitEvidenceRouter(): Router {
  const router=Router(),auth=authenticationMiddleware;
  const read=requirePermission('permit.read'),manage=requirePermission('permit.manage');
  router.post('/permits/:permitId/evidence-requirements',auth,manage,createRequirementHandler);
  router.get('/permits/:permitId/evidence-requirements',auth,read,listRequirementsHandler);
  router.post('/permits/:permitId/evidence',auth,manage,submitEvidenceHandler);
  router.get('/permits/:permitId/evidence',auth,read,listEvidenceHandler);
  router.get('/permits/:permitId/evidence-readiness',auth,read,readinessHandler);
  router.get('/permit-evidence',auth,read,listEvidenceByFiltersHandler);
  router.get('/permit-evidence/:id',auth,read,getEvidenceHandler);
  router.patch('/permit-evidence/:id',auth,manage,removeEvidenceHandler);
  return router;
}
