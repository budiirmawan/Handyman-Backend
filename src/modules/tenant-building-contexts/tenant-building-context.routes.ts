import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTenantBuildingContextHandler,
  getTenantBuildingContextHandler,
  listBuildingTenantContextsHandler,
  listTenantBuildingContextsHandler,
  updateTenantBuildingContextHandler,
} from './tenant-building-context.controller';

/** BE-14D — Tenant Building Context endpoints. */
export function createTenantBuildingContextRouter(): Router {
  const router = Router();
  router.post(
    '/tenant-companies/:tenantCompanyId/building-contexts',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    createTenantBuildingContextHandler,
  );
  router.get(
    '/tenant-companies/:tenantCompanyId/building-contexts',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    listTenantBuildingContextsHandler,
  );
  router.get(
    '/buildings/:buildingId/tenant-contexts',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    listBuildingTenantContextsHandler,
  );
  router.get(
    '/tenant-building-contexts/:id',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    getTenantBuildingContextHandler,
  );
  router.patch(
    '/tenant-building-contexts/:id',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    updateTenantBuildingContextHandler,
  );
  return router;
}
