import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { cleaningAreaService } from './cleaning-area.service';
import {
  parseCleaningAreaBuildingIdParam,
  parseCleaningAreaFilter,
  parseCleaningAreaIdParam,
  parseCreateCleaningAreaBody,
  parseUpdateCleaningAreaBody,
} from './cleaning-area.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createCleaningAreaHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseCleaningAreaBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreateCleaningAreaBody(req.body);
    const cleaningArea = await cleaningAreaService.createCleaningArea({
      ...input,
      buildingId,
    });
    sendSuccess(res, cleaningArea, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingCleaningAreasHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseCleaningAreaBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const filter = parseCleaningAreaFilter(
      req.query as Record<string, unknown>,
    );
    const cleaningAreas =
      await cleaningAreaService.listCleaningAreasByBuilding(
        buildingId,
        filter,
      );
    sendSuccess(res, cleaningAreas);
  } catch (error) {
    next(error);
  }
}

export async function getCleaningAreaHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseCleaningAreaIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const cleaningArea = await cleaningAreaService.getCleaningAreaById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      cleaningArea.buildingId,
    );

    sendSuccess(res, cleaningArea);
  } catch (error) {
    next(error);
  }
}

export async function updateCleaningAreaHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseCleaningAreaIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await cleaningAreaService.getCleaningAreaById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdateCleaningAreaBody(req.body);
    const updated = await cleaningAreaService.updateCleaningArea(id, input);
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}
