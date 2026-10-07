import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementVendorSummaryHandler } from './management-vendor-summary.controller';

/**
 * BE-24 PART 04B — Management / Owner Vendor Summary & Performance.
 *
 *   GET /management/vendor-summary
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601][&overdueAfterDays=N]
 */
export function createManagementVendorSummaryRouter(): Router {
  const router = Router();
  router.get(
    '/management/vendor-summary',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementVendorSummaryHandler,
  );
  return router;
}
