import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementWorkforceSummaryService } from './management-workforce-summary.service';
import { parseManagementWorkforceSummaryQuery } from './management-workforce-summary.validation';

/** GET /management/workforce-summary — BE-24 PART 04A. */
export async function getManagementWorkforceSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementWorkforceSummaryQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementWorkforceSummaryService.getManagementWorkforceSummary(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
