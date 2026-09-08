import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { floorService } from './floor.service';
import {
  parseCreateFloorBody,
  parseFloorBuildingIdParam,
  parseFloorIdParam,
  parseUpdateFloorBody,
} from './floor.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createFloorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseFloorBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreateFloorBody(req.body);
    const floor = await floorService.createFloor({ ...input, buildingId });
    sendSuccess(res, floor, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingFloorsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseFloorBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const floors = await floorService.listFloorsByBuilding(buildingId);
    sendSuccess(res, floors);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /floors/:id` and `PATCH /floors/:id` carry no `buildingId` route
 * parameter, so BE-02 Building isolation is enforced here instead of via
 * `requireBuildingAccess`: the Floor is loaded first (unknown id → 404), then
 * the caller must hold an ACTIVE assignment to the Floor's Building
 * (otherwise 403 BUILDING_ACCESS_DENIED). Permission alone is never enough.
 */
export async function getFloorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseFloorIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const floor = await floorService.getFloorById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      floor.buildingId,
    );

    sendSuccess(res, floor);
  } catch (error) {
    next(error);
  }
}

export async function updateFloorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseFloorIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateFloorBody(req.body);

    const existing = await floorService.getFloorById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const floor = await floorService.updateFloor(id, input);
    sendSuccess(res, floor);
  } catch (error) {
    next(error);
  }
}
