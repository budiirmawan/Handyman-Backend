import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { vendorTenantKpiService } from './vendor-tenant-kpi.service';
import { parseVendorTenantKpiQuery } from './vendor-tenant-kpi.validation';

/**
 * BE-23H — Vendor / Tenant KPI controller.
 *
 * GET /reports/vendor-tenant-kpi
 */
export async function vendorTenantKpiHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseVendorTenantKpiQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await vendorTenantKpiService.getVendorTenantKpi(filters, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
