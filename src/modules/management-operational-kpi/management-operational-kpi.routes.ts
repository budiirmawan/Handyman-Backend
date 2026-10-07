import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementOperationalKpiHandler } from './management-operational-kpi.controller';

/**
 * BE-24 PART 07 — Management / Owner Operational KPI.
 *
 *   GET /management/operational-kpi
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601][&graceMinutes=N]
 */
export function createManagementOperationalKpiRouter(): Router {
  const router = Router();
  router.get(
    '/management/operational-kpi',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementOperationalKpiHandler,
  );
  return router;
}
