import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelTenantUtilityRequestHandler,
  createTenantUtilityRequestHandler,
  createUtilityWorkOrderHandler,
  createUtilityWorkRequestHandler,
  getTenantUtilityRequestActionsHandler,
  getTenantUtilityRequestHandler,
  listBuildingUtilityRequestsHandler,
  listTenantUtilityRequestsHandler,
  updateTenantUtilityRequestHandler,
} from './tenant-utility-request.controller';

/** BE-14G — Tenant Utility Request intake with BE-08 bindings. */
export function createTenantUtilityRequestRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  router.post('/tenant-companies/:tenantCompanyId/utility-requests', auth, manage, createTenantUtilityRequestHandler);
  router.get('/tenant-companies/:tenantCompanyId/utility-requests', auth, read, listTenantUtilityRequestsHandler);
  router.get('/buildings/:buildingId/tenant-utility-requests', auth, read, listBuildingUtilityRequestsHandler);
  router.get('/tenant-utility-requests/:id/available-actions', auth, read, getTenantUtilityRequestActionsHandler);
  router.post('/tenant-utility-requests/:id/work-request', auth, manage, createUtilityWorkRequestHandler);
  router.post('/tenant-utility-requests/:id/work-order', auth, manage, createUtilityWorkOrderHandler);
  router.post('/tenant-utility-requests/:id/cancel', auth, manage, cancelTenantUtilityRequestHandler);
  router.get('/tenant-utility-requests/:id', auth, read, getTenantUtilityRequestHandler);
  router.patch('/tenant-utility-requests/:id', auth, manage, updateTenantUtilityRequestHandler);
  return router;
}
