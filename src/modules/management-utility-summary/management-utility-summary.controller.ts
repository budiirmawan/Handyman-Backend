import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { managementUtilitySummaryService } from './management-utility-summary.service';
import { parseBuildingUtilityOperationalSummaryQuery, parseManagementUtilitySummaryQuery } from './management-utility-summary.validation';

/** GET /management/utility-summary — BE-24 PART 06A. */
export async function getManagementUtilitySummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseManagementUtilitySummaryQuery(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await managementUtilitySummaryService.getManagementUtilitySummary(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getBuildingUtilityOperationalSummaryHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const raw = Array.isArray(req.params.buildingId) ? req.params.buildingId[0] ?? '' : req.params.buildingId ?? '';
    sendSuccess(res, await managementUtilitySummaryService.getBuildingUtilityOperationalSummary(
      parseBuildingUtilityOperationalSummaryQuery(raw, req.query as Record<string, unknown>),
      req.auth.userId,
    ));
  } catch (error) { next(error); }
}
