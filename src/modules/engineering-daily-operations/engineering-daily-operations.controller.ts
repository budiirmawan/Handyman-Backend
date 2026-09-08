import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { engineeringDailyOperationsService } from './engineering-daily-operations.service';
import {
  parseBuildingIdParam,
  parseDailyOperationsQuery,
} from './engineering-daily-operations.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * BE-10A — `GET /buildings/:buildingId/engineering/daily-operations`.
 *
 * Read-only consolidated daily operational view. The route mounts
 * `requireBuildingAccess('buildingId')` (BE-02G), so cross-Building /
 * cross-Client access is rejected before this handler runs; the service
 * re-asserts access as defense in depth.
 */
export async function getDailyEngineeringOperationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const { operationalDate, shiftId } = parseDailyOperationsQuery(
      req.query as Record<string, unknown>,
    );

    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const result = await engineeringDailyOperationsService.getDailyEngineeringOperations(
      { buildingId, operationalDate, shiftId },
      req.auth.userId,
    );

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
