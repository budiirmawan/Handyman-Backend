import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { campusService } from './campus.service';
import {
  parseCampusIdParam,
  parseCampusPropertyIdParam,
  parseCreateCampusBody,
  parseSetBuildingCampusBody,
  parseUpdateCampusBody,
} from './campus.validation';
import { parseBuildingIdParam } from '../buildings';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createCampusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const propertyId = parseCampusPropertyIdParam(
      paramString(req.params.propertyId),
    );
    const input = parseCreateCampusBody(req.body);
    const campus = await campusService.createCampus({ ...input, propertyId });
    sendSuccess(res, campus, 201);
  } catch (error) {
    next(error);
  }
}

export async function listPropertyCampusesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const propertyId = parseCampusPropertyIdParam(
      paramString(req.params.propertyId),
    );
    const campuses = await campusService.listCampusesByProperty(propertyId);
    sendSuccess(res, campuses);
  } catch (error) {
    next(error);
  }
}

export async function getCampusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseCampusIdParam(paramString(req.params.id));
    const campus = await campusService.getCampusById(id);
    sendSuccess(res, campus);
  } catch (error) {
    next(error);
  }
}

export async function updateCampusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseCampusIdParam(paramString(req.params.id));
    const input = parseUpdateCampusBody(req.body);
    const campus = await campusService.updateCampus(id, input);
    sendSuccess(res, campus);
  } catch (error) {
    next(error);
  }
}

export async function setBuildingCampusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const input = parseSetBuildingCampusBody(req.body);
    const building = await campusService.setBuildingCampus(buildingId, input);
    sendSuccess(res, building);
  } catch (error) {
    next(error);
  }
}
