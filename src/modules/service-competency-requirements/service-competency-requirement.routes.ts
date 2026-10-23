import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createCompetencyRequirementHandler,
  deactivateCompetencyRequirementHandler,
  getCompetencyRequirementHandler,
  listCompetencyRequirementsHandler,
  updateCompetencyRequirementHandler,
} from './service-competency-requirement.controller';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — competency requirements per JOB TYPE.
 *
 *   GET   /service-catalog/entries/:id/competency-requirements
 *   POST  /service-catalog/entries/:id/competency-requirements        (201)
 *   GET   /service-catalog/entries/:id/competency-requirements/:requirementId
 *   PATCH /service-catalog/entries/:id/competency-requirements/:requirementId
 *   POST  /service-catalog/entries/:id/competency-requirements/:requirementId/deactivate
 *
 * Why these live on the catalog entry: the entry IS the job type. Requirements
 * configured here are consumed by the EXISTING assignment authority
 * (CR-HM-04 `handyman-scope-assignment.service.ts`), never by a second
 * assignment path.
 *
 * Permissions reuse the catalog vocabulary on purpose — `service_catalog.read`
 * for reads, `service_catalog.manage` for configuration. No new permission code
 * is introduced, and no broader code (`skill.*`, `workforce.*`,
 * `tenant_company.*`) is accepted as a substitute. Client reach is still
 * enforced independently in the service through the caller's Building
 * assignments.
 */
export function createServiceCompetencyRequirementRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('service_catalog.read');
  const manage = requirePermission('service_catalog.manage');
  const base = '/service-catalog/entries/:id/competency-requirements';

  router.get(base, auth, read, listCompetencyRequirementsHandler);
  router.post(base, auth, manage, createCompetencyRequirementHandler);
  router.get(`${base}/:requirementId`, auth, read, getCompetencyRequirementHandler);
  router.patch(
    `${base}/:requirementId`,
    auth,
    manage,
    updateCompetencyRequirementHandler,
  );
  router.post(
    `${base}/:requirementId/deactivate`,
    auth,
    manage,
    deactivateCompetencyRequirementHandler,
  );

  return router;
}
