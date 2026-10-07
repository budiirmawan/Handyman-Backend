import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementCriticalFindingsHandler } from './management-critical-findings.controller';

/**
 * BE-24 PART 03B — Management / Owner Critical Findings read model.
 *
 *   GET /management/critical-findings
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601]
 *     [&overdueAfterDays=N]
 */
export function createManagementCriticalFindingsRouter(): Router {
  const router = Router();
  router.get(
    '/management/critical-findings',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementCriticalFindingsHandler,
  );
  return router;
}
