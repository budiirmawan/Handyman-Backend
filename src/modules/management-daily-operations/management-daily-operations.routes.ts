import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementDailyOperationsHandler } from './management-daily-operations.controller';

/**
 * BE-24 PART 02A — Management / Owner Daily Operations.
 *
 *   GET /management/daily-operations
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&date=YYYY-MM-DD][&graceMinutes=N]
 *
 * Read-only aggregate. Operations Command Center is not implemented here.
 */
export function createManagementDailyOperationsRouter(): Router {
  const router = Router();

  router.get(
    '/management/daily-operations',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementDailyOperationsHandler,
  );

  return router;
}
