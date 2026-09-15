import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementWorkforceSummaryHandler } from './management-workforce-summary.controller';

/**
 * BE-24 PART 04A — Management / Owner Workforce Summary.
 *
 *   GET /management/workforce-summary
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601][&graceMinutes=N]
 */
export function createManagementWorkforceSummaryRouter(): Router {
  const router = Router();
  router.get(
    '/management/workforce-summary',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementWorkforceSummaryHandler,
  );
  return router;
}
