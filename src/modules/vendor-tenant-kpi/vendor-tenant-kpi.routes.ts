import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { vendorTenantKpiHandler } from './vendor-tenant-kpi.controller';

/**
 * BE-23H — Vendor / Tenant KPI endpoint.
 *
 *   GET /reports/vendor-tenant-kpi
 *     [?buildingId=...][&vendorId=...][&tenantCompanyId=...]
 *     [&requestType=...][&dateFrom=YYYY-MM-DD][&dateTo=YYYY-MM-DD]
 *     [&overdueAfterDays=N]
 *
 * Requires authentication plus `vendor_tenant_kpi.read`. Omitting
 * `buildingId` rolls the KPI up across every accessible Building.
 *
 * Read-only: direct queries over the BE-15 Vendor Work, BE-06 Vendor,
 * BE-14E Tenant Service Request and BE-08 Work Order records. No ETL,
 * no warehouse, and no mutation of source domain state.
 */
export function createVendorTenantKpiRouter(): Router {
  const router = Router();

  router.get(
    '/reports/vendor-tenant-kpi',
    authenticationMiddleware,
    requirePermission('vendor_tenant_kpi.read'),
    vendorTenantKpiHandler,
  );

  return router;
}
