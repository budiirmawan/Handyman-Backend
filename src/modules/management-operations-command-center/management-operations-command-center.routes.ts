import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementOperationsCommandCenterHandler } from './management-operations-command-center.controller';

/**
 * BE-24 PART 09 — Management / Owner Operations Command Center.
 *
 *   GET /management/operations-command-center
 *     [?clientId=...][&buildingId=...|&buildingIds=id1,id2]
 *     [&date=YYYY-MM-DD][&dateFrom=ISO-8601][&dateTo=ISO-8601]
 *     [&graceMinutes=N][&overdueAfterDays=N][&expiringWithinDays=N]
 *     [&interval=DAY|MONTH|YEAR][&includeSubMeters=true|false]
 */
export function createManagementOperationsCommandCenterRouter(): Router {
  const router = Router();
  router.get(
    '/management/operations-command-center',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementOperationsCommandCenterHandler,
  );
  return router;
}
