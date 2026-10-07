import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  listHousekeepingEvidenceRequirementsHandler,
  listHousekeepingEvidenceSubmissionsHandler,
  submitHousekeepingEvidenceHandler,
} from './housekeeping-evidence.controller';

/**
 * BE-11I — Housekeeping Evidence Binding endpoints.
 *
 *   GET  /housekeeping/:sourceType/:sourceId/evidence-requirements
 *   GET  /housekeeping/:sourceType/:sourceId/evidence
 *   POST /housekeeping/:sourceType/:sourceId/evidence
 */
export function createHousekeepingEvidenceRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('housekeeping_evidence.manage');
  const read = requirePermission('housekeeping_evidence.read');

  router.get(
    '/housekeeping/:sourceType/:sourceId/evidence-requirements',
    auth,
    read,
    listHousekeepingEvidenceRequirementsHandler,
  );
  router.get(
    '/housekeeping/:sourceType/:sourceId/evidence',
    auth,
    read,
    listHousekeepingEvidenceSubmissionsHandler,
  );
  router.post(
    '/housekeeping/:sourceType/:sourceId/evidence',
    auth,
    manage,
    submitHousekeepingEvidenceHandler,
  );

  return router;
}
