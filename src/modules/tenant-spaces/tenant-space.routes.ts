import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignTenantSpaceHandler,
  getTenantSpaceHandler,
  listBuildingTenantSpacesHandler,
  listTenantSpacesHandler,
  updateTenantSpaceHandler,
} from './tenant-space.controller';

/** BE-14C — Tenant Company ↔ Space relationships. */
export function createTenantSpaceRouter(): Router {
  const router = Router();
  router.post(
    '/tenant-companies/:tenantCompanyId/spaces',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    assignTenantSpaceHandler,
  );
  router.get(
    '/tenant-companies/:tenantCompanyId/spaces',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    listTenantSpacesHandler,
  );
  router.get(
    '/buildings/:buildingId/tenant-spaces',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    listBuildingTenantSpacesHandler,
  );
  router.get(
    '/tenant-space-relationships/:id',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    getTenantSpaceHandler,
  );
  router.patch(
    '/tenant-space-relationships/:id',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    updateTenantSpaceHandler,
  );
  return router;
}
