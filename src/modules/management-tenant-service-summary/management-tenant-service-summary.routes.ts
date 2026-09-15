import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementTenantServiceSummaryHandler } from './management-tenant-service-summary.controller';

/**
 * BE-24 PART 04C — Management / Owner Tenant Service Summary.
 *
 *   GET /management/tenant-service-summary
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601][&overdueAfterDays=N]
 */
export function createManagementTenantServiceSummaryRouter(): Router {
  const router = Router();
  router.get(
    '/management/tenant-service-summary',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementTenantServiceSummaryHandler,
  );
  return router;
}
