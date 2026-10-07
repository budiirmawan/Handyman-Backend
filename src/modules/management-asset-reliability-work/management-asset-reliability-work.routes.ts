import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementAssetReliabilityWorkHandler } from './management-asset-reliability-work.controller';

/**
 * BE-24 PART 05B — Management / Owner Asset Reliability & Work.
 *
 *   GET /management/asset-reliability-work
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601][&graceMinutes=N]
 */
export function createManagementAssetReliabilityWorkRouter(): Router {
  const router = Router();
  router.get(
    '/management/asset-reliability-work',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementAssetReliabilityWorkHandler,
  );
  return router;
}
