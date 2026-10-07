import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import { getManagementBuildingOperationalFinanceSummaryHandler } from './management-building-operational-finance.controller';

/**
 * CR-BE-FIN-01 PART 06 — read-only Building Operational Finance summary.
 *
 * The requested period is explicit. All monetary values are delegated through
 * the PART 05 management contract to PART 04 aggregation; this route adds only
 * Building-level indicators and category utilization.
 */
export function createManagementBuildingOperationalFinanceRouter(): Router {
  const router = Router();
  router.get(
    '/management/buildings/:buildingId/operational-finance-summary',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    requireBuildingAccess('buildingId'),
    getManagementBuildingOperationalFinanceSummaryHandler,
  );
  return router;
}
