import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import { getEngineeringOverviewHandler } from './engineering-overview.controller';

/**
 * BE-10K — Engineering Aggregation endpoint.
 *
 *   GET /buildings/:buildingId/engineering/overview?date=&shiftId=
 *
 * One concise read model composed from the authoritative BE-10A operations,
 * BE-08/09 aggregates, and the BE-10J handover dataset. READ-ONLY — no
 * operational writes exist here.
 */
export function createEngineeringOverviewRouter(): Router {
  const router = Router();

  router.get(
    '/buildings/:buildingId/engineering/overview',
    authenticationMiddleware,
    requirePermission('engineering_overview.read'),
    requireBuildingAccess('buildingId'),
    getEngineeringOverviewHandler,
  );

  return router;
}
