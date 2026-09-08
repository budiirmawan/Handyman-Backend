import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementFinancialSummaryService } from './management-financial-summary.service';
import { parseManagementFinancialSummaryQuery } from './management-financial-summary.validation';

/** GET /management/financial-summary — BE-24 PART 06B. */
export async function getManagementFinancialSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementFinancialSummaryQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementFinancialSummaryService.getManagementFinancialSummary(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
