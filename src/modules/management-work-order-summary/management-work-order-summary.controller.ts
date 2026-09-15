import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementWorkOrderSummaryService } from './management-work-order-summary.service';
import { parseManagementWorkOrderSummaryQuery } from './management-work-order-summary.validation';

/** GET /management/work-order-summary — BE-24 PART 02B. */
export async function getManagementWorkOrderSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementWorkOrderSummaryQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementWorkOrderSummaryService.getManagementWorkOrderSummary(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
