import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementWorkOrderSummaryHandler } from './management-work-order-summary.controller';

/**
 * BE-24 PART 02B — Management / Owner Work Order Summary.
 *
 *   GET /management/work-order-summary
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601]
 *     [&overdueAfterDays=N]
 */
export function createManagementWorkOrderSummaryRouter(): Router {
  const router = Router();
  router.get(
    '/management/work-order-summary',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementWorkOrderSummaryHandler,
  );
  return router;
}
