import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  assignWorkforceBuildingHandler,
  listBuildingWorkforceHandler,
  listWorkforceBuildingsHandler,
  updateWorkforceBuildingHandler,
} from './workforce-building-assignment.controller';

/**
 * BE-03G — Workforce Building Assignment endpoints, protected by BE-01 RBAC.
 *
 * Reuses the BE-03C workforce permissions rather than introducing new codes:
 *   `workforce.read`   → GET   /workforce/:workforceId/buildings
 *                        GET   /buildings/:buildingId/workforce
 *   `workforce.manage` → POST  /workforce/:workforceId/buildings
 *                        PATCH /workforce/:workforceId/buildings/:buildingId
 *
 * The Building-nested route additionally passes through BE-02G
 * `requireBuildingAccess`, matching the BE-03E Shift precedent: reading a
 * Building's roster is reading that Building's data, so the caller's own
 * BE-02F access still applies. Note the direction — access is *required to
 * read*, never *granted by* these assignments.
 *
 * Deactivation is a PATCH with `{ "status": "INACTIVE" }`, not a DELETE, so the
 * placement history survives.
 */
export function createWorkforceBuildingAssignmentRouter(): Router {
  const router = Router();

  router.post(
    '/workforce/:workforceId/buildings',
    authenticationMiddleware,
    requirePermission('workforce.manage'),
    assignWorkforceBuildingHandler,
  );
  router.get(
    '/workforce/:workforceId/buildings',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listWorkforceBuildingsHandler,
  );
  router.get(
    '/buildings/:buildingId/workforce',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    requireBuildingAccess('buildingId'),
    listBuildingWorkforceHandler,
  );
  router.patch(
    '/workforce/:workforceId/buildings/:buildingId',
    authenticationMiddleware,
    requirePermission('workforce.manage'),
    updateWorkforceBuildingHandler,
  );

  return router;
}
