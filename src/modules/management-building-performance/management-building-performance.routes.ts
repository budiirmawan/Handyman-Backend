import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementBuildingPerformanceHandler } from './management-building-performance.controller';

/**
 * BE-24 PART 08A — Management / Owner Building Performance.
 *
 *   GET /management/building-performance
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601]
 *     [&graceMinutes=N][&overdueAfterDays=N][&expiringWithinDays=N]
 *     [&interval=DAY|MONTH|YEAR][&includeSubMeters=true|false]
 */
export function createManagementBuildingPerformanceRouter(): Router {
  const router = Router();
  router.get(
    '/management/building-performance',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementBuildingPerformanceHandler,
  );
  return router;
}
