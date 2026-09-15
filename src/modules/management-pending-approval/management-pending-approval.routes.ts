import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getManagementPendingApprovalHandler } from './management-pending-approval.controller';

/**
 * BE-24 PART 03A — Management / Owner Pending Approval read model.
 *
 *   GET /management/pending-approvals
 *     [?clientId=...]
 *     [&buildingId=... | &buildingIds=id1,id2]
 *     [&dateFrom=ISO-8601][&dateTo=ISO-8601]
 */
export function createManagementPendingApprovalRouter(): Router {
  const router = Router();
  router.get(
    '/management/pending-approvals',
    authenticationMiddleware,
    requirePermission('management_read_model.read'),
    getManagementPendingApprovalHandler,
  );
  return router;
}
