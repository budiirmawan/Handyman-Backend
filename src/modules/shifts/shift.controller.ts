import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { shiftService } from './shift.service';
import {
  parseCreateShiftBody,
  parseShiftBuildingIdParam,
  parseShiftIdParam,
} from './shift.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createShiftHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The Building always comes from the route, never from the body.
    const buildingId = parseShiftBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreateShiftBody(req.body);
    const shift = await shiftService.createShift({ ...input, buildingId });
    sendSuccess(res, shift, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingShiftsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseShiftBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const shifts = await shiftService.listShiftsByBuilding(buildingId);
    sendSuccess(res, shifts);
  } catch (error) {
    next(error);
  }
}

export async function getShiftHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseShiftIdParam(paramString(req.params.id));
    const shift = await shiftService.getShiftById(id);
    sendSuccess(res, shift);
  } catch (error) {
    next(error);
  }
}
