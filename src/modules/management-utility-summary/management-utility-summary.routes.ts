import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getBuildingUtilityOperationalSummaryHandler, getManagementUtilitySummaryHandler } from './management-utility-summary.controller';
import { requireBuildingAccess } from '../context-access';

/**
 * BE-24 PART 06A — Management / Owner Utility Summary.
 *
 *   GET /management/utility-summary
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601]
 *     [&interval=DAY|MONTH|YEAR][&includeSubMeters=true|false]
 */
export function createManagementUtilitySummaryRouter(): Router {
  const router = Router();
  router.get(
    '/buildings/:buildingId/utility-summary',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    requireBuildingAccess('buildingId'),
    getBuildingUtilityOperationalSummaryHandler,
  );
  router.get(
    '/management/utility-summary',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementUtilitySummaryHandler,
  );
  return router;
}
