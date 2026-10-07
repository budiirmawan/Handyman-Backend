import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { cleaningAreaService } from '../cleaning-areas';
import { contextAccessService } from '../context-access';
import { dailyCleaningService } from './daily-cleaning.service';
import {
  parseDailyCleaningAreaIdParam,
  parseDailyCleaningBuildingIdParam,
  parseDailyCleaningFilter,
  parseDailyCleaningIdParam,
} from './daily-cleaning.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function listDailyCleaningByBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseDailyCleaningBuildingIdParam(
      paramString(req.params.buildingId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      buildingId,
    );

    const filter = parseDailyCleaningFilter(
      req.query as Record<string, unknown>,
    );
    const results =
      await dailyCleaningService.listDailyCleaningByBuilding(
        buildingId,
        filter,
      );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getDailyCleaningHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseDailyCleaningIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const result = await dailyCleaningService.getDailyCleaningById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      result.buildingId,
    );

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function listAreaDailyCleaningHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cleaningAreaId = parseDailyCleaningAreaIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const cleaningArea =
      await cleaningAreaService.getCleaningAreaById(cleaningAreaId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      cleaningArea.buildingId,
    );

    const filter = parseDailyCleaningFilter(
      req.query as Record<string, unknown>,
    );
    const results = await dailyCleaningService.listDailyCleaningByArea(
      cleaningAreaId,
      filter,
    );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}
