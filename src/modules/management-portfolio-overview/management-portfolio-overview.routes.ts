import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementPortfolioOverviewHandler } from './management-portfolio-overview.controller';

/**
 * BE-24 PART 08B — Management / Owner Portfolio Overview.
 *
 *   GET /management/portfolio-overview
 *     [?clientId=...][&buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601]
 *     [&graceMinutes=N][&overdueAfterDays=N][&expiringWithinDays=N]
 *     [&interval=DAY|MONTH|YEAR][&includeSubMeters=true|false]
 */
export function createManagementPortfolioOverviewRouter(): Router {
  const router = Router();
  router.get(
    '/management/portfolio-overview',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementPortfolioOverviewHandler,
  );
  return router;
}
