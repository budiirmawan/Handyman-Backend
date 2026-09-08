import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelTenantComplaintHandler,
  createComplaintFindingHandler,
  createComplaintWorkOrderHandler,
  createTenantComplaintHandler,
  getTenantComplaintActionsHandler,
  getTenantComplaintHandler,
  listBuildingComplaintsHandler,
  listTenantComplaintsHandler,
  updateTenantComplaintHandler,
} from './tenant-complaint.controller';

/** BE-14F — Tenant Complaint intake with BE-09 / BE-08 bindings. */
export function createTenantComplaintRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  router.post('/tenant-companies/:tenantCompanyId/complaints', auth, manage, createTenantComplaintHandler);
  router.get('/tenant-companies/:tenantCompanyId/complaints', auth, read, listTenantComplaintsHandler);
  router.get('/buildings/:buildingId/tenant-complaints', auth, read, listBuildingComplaintsHandler);
  router.get('/tenant-complaints/:id/available-actions', auth, read, getTenantComplaintActionsHandler);
  router.post('/tenant-complaints/:id/finding', auth, manage, createComplaintFindingHandler);
  router.post('/tenant-complaints/:id/work-order', auth, manage, createComplaintWorkOrderHandler);
  router.post('/tenant-complaints/:id/cancel', auth, manage, cancelTenantComplaintHandler);
  router.get('/tenant-complaints/:id', auth, read, getTenantComplaintHandler);
  router.patch('/tenant-complaints/:id', auth, manage, updateTenantComplaintHandler);
  return router;
}
