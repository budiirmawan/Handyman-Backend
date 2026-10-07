import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorBuildingService } from './vendor-building.service';
import {
  parseAssignVendorBuildingBody,
  parseBuildingIdParam,
  parseUpdateVendorBuildingBody,
  parseVendorIdParam,
} from './vendor-building.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function assignVendorBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorIdParam(paramString(req.params.vendorId));
    const input = parseAssignVendorBuildingBody(req.body);
    const relationship = await vendorBuildingService.assignBuildingToVendor({
      ...input,
      vendorId,
    });
    sendSuccess(res, relationship, 201);
  } catch (error) {
    next(error);
  }
}

export async function listVendorBuildingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorIdParam(paramString(req.params.vendorId));
    const relationships =
      await vendorBuildingService.listVendorBuildings(vendorId);
    sendSuccess(res, relationships);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingVendorsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const relationships =
      await vendorBuildingService.listBuildingVendors(buildingId);
    sendSuccess(res, relationships);
  } catch (error) {
    next(error);
  }
}

export async function updateVendorBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorIdParam(paramString(req.params.vendorId));
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const input = parseUpdateVendorBuildingBody(req.body);
    const relationship =
      await vendorBuildingService.updateVendorBuildingRelationship(
        vendorId,
        buildingId,
        input,
      );
    sendSuccess(res, relationship);
  } catch (error) {
    next(error);
  }
}
