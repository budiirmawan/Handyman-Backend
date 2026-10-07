import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementPortfolioOverviewService } from './management-portfolio-overview.service';
import { parseManagementPortfolioOverviewQuery } from './management-portfolio-overview.validation';

/** GET /management/portfolio-overview — BE-24 PART 08B. */
export async function getManagementPortfolioOverviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementPortfolioOverviewQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementPortfolioOverviewService.getManagementPortfolioOverview(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
