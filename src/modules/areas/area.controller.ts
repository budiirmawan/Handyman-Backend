import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { areaService, resolveFloorBuildingId } from './area.service';
import {
  parseAreaFloorIdParam,
  parseAreaIdParam,
  parseCreateAreaBody,
  parseUpdateAreaBody,
} from './area.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * Area routes carry no `buildingId` route parameter, so BE-02 Building
 * isolation is enforced here instead of via `requireBuildingAccess`: the
 * Floor (or Area → Floor) is resolved to its Building first (unknown parent
 * → 404), then the caller must hold an ACTIVE assignment to that Building
 * (otherwise 403 BUILDING_ACCESS_DENIED). Permission alone is never enough.
 */
async function assertFloorAccess(req: Request, floorId: string): Promise<void> {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  const buildingId = await resolveFloorBuildingId(floorId);
  await contextAccessService.assertBuildingAccess(req.auth.userId, buildingId);
}

export async function createAreaHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const floorId = parseAreaFloorIdParam(paramString(req.params.floorId));
    await assertFloorAccess(req, floorId);

    const input = parseCreateAreaBody(req.body);
    const area = await areaService.createArea({ ...input, floorId });
    sendSuccess(res, area, 201);
  } catch (error) {
    next(error);
  }
}

export async function listFloorAreasHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const floorId = parseAreaFloorIdParam(paramString(req.params.floorId));
    await assertFloorAccess(req, floorId);

    const areas = await areaService.listAreasByFloor(floorId);
    sendSuccess(res, areas);
  } catch (error) {
    next(error);
  }
}

export async function getAreaHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAreaIdParam(paramString(req.params.id));
    const area = await areaService.getAreaById(id);
    await assertFloorAccess(req, area.floorId);

    sendSuccess(res, area);
  } catch (error) {
    next(error);
  }
}

export async function updateAreaHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAreaIdParam(paramString(req.params.id));
    const input = parseUpdateAreaBody(req.body);

    const existing = await areaService.getAreaById(id);
    await assertFloorAccess(req, existing.floorId);

    const area = await areaService.updateArea(id, input);
    sendSuccess(res, area);
  } catch (error) {
    next(error);
  }
}
