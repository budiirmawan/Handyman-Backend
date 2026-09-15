import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { housekeepingFindingService } from './housekeeping-finding.service';
import {
  parseCreateHousekeepingFindingBody,
  parseHousekeepingFindingFilter,
  parseHousekeepingFindingIdParam,
} from './housekeeping-finding.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createHousekeepingFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCreateHousekeepingFindingBody(req.body);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      input.buildingId,
    );

    const result =
      await housekeepingFindingService.createHousekeepingFinding(
        input,
        req.auth.userId,
      );

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listHousekeepingFindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseHousekeepingFindingFilter(
      req.query as Record<string, unknown>,
    );
    if (filter.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filter.buildingId,
      );
    }

    const results =
      await housekeepingFindingService.listHousekeepingFindings(
        filter,
        req.auth.userId,
      );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getHousekeepingFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHousekeepingFindingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const result =
      await housekeepingFindingService.getHousekeepingFindingById(
        id,
        req.auth.userId,
      );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      result.buildingId,
    );

    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
