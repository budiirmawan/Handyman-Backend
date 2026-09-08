import type { NextFunction, Request, Response } from 'express';
import { getAccessibleBuildingIds } from '../context-access';
import { sendSuccess } from '../../shared/api-response';
import { workforceReportingService } from './workforce-reporting.service';
import {
  parseWorkforceReportingIdParam,
  parseWorkforceReportingQuery,
} from './workforce-reporting.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function listWorkforceReportingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseWorkforceReportingQuery(
      req.query as Record<string, unknown>,
    );
    const accessibleBuildingIds = await getAccessibleBuildingIds(req.auth.userId);
    const page = await workforceReportingService.listWorkforceReportingPage(
      {
        ...query,
        accessibleBuildingIds,
        requireAccessibleBuilding: true,
      },
      query.page,
      query.limit,
    );

    sendSuccess(res, page.items, 200, {
      page: page.page,
      limit: page.limit,
      total: page.total,
    });
  } catch (error) {
    next(error);
  }
}

export async function getWorkforceReportingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkforceReportingIdParam(paramString(req.params.id));
    const accessibleBuildingIds = await getAccessibleBuildingIds(req.auth.userId);
    const record = await workforceReportingService.getRequiredWorkforceReporting(
      id,
      { accessibleBuildingIds, requireAccessibleBuilding: true },
    );

    sendSuccess(res, record);
  } catch (error) {
    next(error);
  }
}
