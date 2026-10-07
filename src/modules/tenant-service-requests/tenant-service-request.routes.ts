import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelTenantServiceRequestHandler,
  createServiceRequestWorkOrderHandler,
  createServiceRequestWorkRequestHandler,
  createTenantServiceRequestHandler,
  getTenantServiceRequestActionsHandler,
  getTenantServiceRequestHandler,
  listBuildingServiceRequestsHandler,
  listTenantServiceRequestsHandler,
  updateTenantServiceRequestHandler,
} from './tenant-service-request.controller';

/** BE-14E — Tenant Service Request intake and BE-08 conversion bindings. */
export function createTenantServiceRequestRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  router.post('/tenant-companies/:tenantCompanyId/service-requests', auth, manage, createTenantServiceRequestHandler);
  router.get('/tenant-companies/:tenantCompanyId/service-requests', auth, read, listTenantServiceRequestsHandler);
  router.get('/buildings/:buildingId/tenant-service-requests', auth, read, listBuildingServiceRequestsHandler);
  router.get('/tenant-service-requests/:id/available-actions', auth, read, getTenantServiceRequestActionsHandler);
  router.post('/tenant-service-requests/:id/work-request', auth, manage, createServiceRequestWorkRequestHandler);
  router.post('/tenant-service-requests/:id/work-order', auth, manage, createServiceRequestWorkOrderHandler);
  router.post('/tenant-service-requests/:id/cancel', auth, manage, cancelTenantServiceRequestHandler);
  router.get('/tenant-service-requests/:id', auth, read, getTenantServiceRequestHandler);
  router.patch('/tenant-service-requests/:id', auth, manage, updateTenantServiceRequestHandler);
  return router;
}
