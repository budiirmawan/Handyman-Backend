import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementReadScopeHandler } from './management-read-scope.controller';

/**
 * BE-24 PART 01 — Management & Owner read-scope contract foundation.
 *
 *   GET /management/read-scope
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601]
 *
 * This endpoint resolves scope/period/provenance only. It exposes no dashboard
 * or management summary and performs no KPI calculation.
 */
export function createManagementReadScopeRouter(): Router {
  const router = Router();

  router.get(
    '/management/read-scope',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementReadScopeHandler,
  );

  return router;
}
