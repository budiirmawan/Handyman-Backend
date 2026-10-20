import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTenantPicHandler,
  getTenantPicHandler,
  listTenantPicsHandler,
  setTenantPicVerificationHandler,
  updateTenantPicHandler,
} from './tenant-pic.controller';

/** BE-14B — Tenant PIC endpoints; reuses BE-14A Tenant Company permissions. */
export function createTenantPicRouter(): Router {
  const router = Router();
  router.post(
    '/tenant-companies/:tenantCompanyId/pics',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    createTenantPicHandler,
  );
  router.get(
    '/tenant-companies/:tenantCompanyId/pics',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    listTenantPicsHandler,
  );
  router.get(
    '/tenant-pics/:id',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    getTenantPicHandler,
  );
  router.patch(
    '/tenant-pics/:id',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    updateTenantPicHandler,
  );
  // CR-HM-MASTER-TENANT-BATCH-01 — auditable PIC verification verdict.
  router.post(
    '/tenant-pics/:id/verification',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    setTenantPicVerificationHandler,
  );
  return router;
}
