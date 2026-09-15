import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementFinancialSummaryHandler } from './management-financial-summary.controller';

/**
 * BE-24 PART 06B — Management / Owner Financial Summary.
 *
 *   GET /management/financial-summary
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601]
 */
export function createManagementFinancialSummaryRouter(): Router {
  const router = Router();
  router.get(
    '/management/financial-summary',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementFinancialSummaryHandler,
  );
  return router;
}
