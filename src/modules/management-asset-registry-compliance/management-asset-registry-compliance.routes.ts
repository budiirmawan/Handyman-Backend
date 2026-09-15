import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementAssetRegistryComplianceHandler } from './management-asset-registry-compliance.controller';

/**
 * BE-24 PART 05A — Management / Owner Asset Registry & Compliance.
 *
 *   GET /management/asset-registry-compliance
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&expiringWithinDays=N]
 */
export function createManagementAssetRegistryComplianceRouter(): Router {
  const router = Router();
  router.get(
    '/management/asset-registry-compliance',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementAssetRegistryComplianceHandler,
  );
  return router;
}
