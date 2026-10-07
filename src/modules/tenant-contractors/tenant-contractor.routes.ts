import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTenantContractorHandler,
  getTenantContractorHandler,
  listBuildingContractorsHandler,
  listContractorTenantsHandler,
  listTenantContractorsHandler,
  updateTenantContractorHandler,
} from './tenant-contractor.controller';

/** BE-14I — Tenant to existing Vendor contractor relationship endpoints. */
export function createTenantContractorRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  router.post('/tenant-companies/:tenantCompanyId/contractor-relationships', auth, manage, createTenantContractorHandler);
  router.get('/tenant-companies/:tenantCompanyId/contractor-relationships', auth, read, listTenantContractorsHandler);
  router.get('/buildings/:buildingId/tenant-contractor-relationships', auth, read, listBuildingContractorsHandler);
  router.get('/vendors/:vendorId/tenant-relationships', auth, read, listContractorTenantsHandler);
  router.get('/tenant-contractor-relationships/:id', auth, read, getTenantContractorHandler);
  router.patch('/tenant-contractor-relationships/:id', auth, manage, updateTenantContractorHandler);
  return router;
}
