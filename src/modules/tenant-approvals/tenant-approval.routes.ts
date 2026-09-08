import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  approveTenantApprovalHandler,
  createTenantApprovalHandler,
  getTenantApprovalActionsHandler,
  getTenantApprovalHandler,
  getUtilityCalculationApprovalContextHandler,
  listPendingTenantApprovalsHandler,
  rejectTenantApprovalHandler,
} from './tenant-approval.controller';

/** BE-14H — explicit Tenant request approval bindings. */
export function createTenantApprovalRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  router.post('/tenant-approvals', auth, manage, createTenantApprovalHandler);
  router.get('/tenant-approvals/pending', auth, read, listPendingTenantApprovalsHandler);
  router.get('/tenant-approvals/:id/available-actions', auth, read, getTenantApprovalActionsHandler);
  router.post('/tenant-approvals/:id/approve', auth, manage, approveTenantApprovalHandler);
  router.post('/tenant-approvals/:id/reject', auth, manage, rejectTenantApprovalHandler);
  router.get('/tenant-approvals/:id', auth, read, getTenantApprovalHandler);
  // BE-18L — Tenant utility approval context, on the same engine.
  router.get(
    '/utility/calculations/:id/tenant-approvals',
    auth,
    read,
    getUtilityCalculationApprovalContextHandler,
  );
  return router;
}
