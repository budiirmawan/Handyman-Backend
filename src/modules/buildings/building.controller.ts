import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { buildingService } from './building.service';
import {
  parseBuildingIdParam,
  parseBuildingPropertyIdParam,
  parseCreateBuildingBody,
  parseUpdateBuildingStatusBody,
} from './building.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateBuildingBody(req.body);
    const building = await buildingService.createBuilding(input);
    sendSuccess(res, building, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawPropertyId = Array.isArray(req.query.propertyId) ? '' : req.query.propertyId;
    const propertyId =
      typeof rawPropertyId === 'string' && rawPropertyId.trim() !== ''
        ? parseBuildingPropertyIdParam(rawPropertyId)
        : undefined;
    const buildings = await buildingService.listBuildings(propertyId);
    sendSuccess(res, buildings);
  } catch (error) {
    next(error);
  }
}

export async function getBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBuildingIdParam(paramString(req.params.id));
    const building = await buildingService.getBuildingById(id);
    sendSuccess(res, building);
  } catch (error) {
    next(error);
  }
}

export async function updateBuildingStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBuildingIdParam(paramString(req.params.id));
    const input = parseUpdateBuildingStatusBody(req.body);
    const building = await buildingService.updateBuildingStatus(id, input);
    sendSuccess(res, building);
  } catch (error) {
    next(error);
  }
}

export async function listPropertyBuildingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const propertyId = parseBuildingPropertyIdParam(paramString(req.params.propertyId));
    const buildings = await buildingService.listBuildingsByProperty(propertyId);
    sendSuccess(res, buildings);
  } catch (error) {
    next(error);
  }
}
