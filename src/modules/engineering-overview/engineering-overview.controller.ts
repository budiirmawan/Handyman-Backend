import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseBuildingIdParam } from '../engineering-daily-operations';
import { engineeringOverviewService } from './engineering-overview.service';
import { parseOverviewQuery } from './engineering-overview.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * BE-10K — `GET /buildings/:buildingId/engineering/overview?date=&shiftId=`.
 * The route mounts `requireBuildingAccess('buildingId')` (BE-02G) before this
 * handler; the service re-asserts access as defense in depth.
 */
export async function getEngineeringOverviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const query = parseOverviewQuery(req.query as Record<string, unknown>);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await engineeringOverviewService.getEngineeringOverview(
        buildingId,
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
