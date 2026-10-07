import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTenantCompanyHandler,
  getTenantCompanyHandler,
  listTenantCompaniesHandler,
  updateTenantCompanyHandler,
} from './tenant-company.controller';

/** BE-14A — Tenant Company endpoints. */
export function createTenantCompanyRouter(): Router {
  const router = Router();
  router.post('/clients/:clientId/tenant-companies', authenticationMiddleware, requirePermission('tenant_company.manage'), createTenantCompanyHandler);
  router.get('/clients/:clientId/tenant-companies', authenticationMiddleware, requirePermission('tenant_company.read'), listTenantCompaniesHandler);
  router.get('/tenant-companies/:id', authenticationMiddleware, requirePermission('tenant_company.read'), getTenantCompanyHandler);
  router.patch('/tenant-companies/:id', authenticationMiddleware, requirePermission('tenant_company.manage'), updateTenantCompanyHandler);
  return router;
}
