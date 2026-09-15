import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementTenantServiceSummaryService } from './management-tenant-service-summary.service';
import { parseManagementTenantServiceSummaryQuery } from './management-tenant-service-summary.validation';

/** GET /management/tenant-service-summary — BE-24 PART 04C. */
export async function getManagementTenantServiceSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementTenantServiceSummaryQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementTenantServiceSummaryService.getManagementTenantServiceSummary(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
