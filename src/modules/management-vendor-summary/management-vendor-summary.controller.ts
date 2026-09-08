import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementVendorSummaryService } from './management-vendor-summary.service';
import { parseManagementVendorSummaryQuery } from './management-vendor-summary.validation';

/** GET /management/vendor-summary — BE-24 PART 04B. */
export async function getManagementVendorSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementVendorSummaryQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementVendorSummaryService.getManagementVendorSummary(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
