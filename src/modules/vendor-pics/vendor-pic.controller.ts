import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorPicService } from './vendor-pic.service';
import {
  parseCreateVendorPicBody,
  parseUpdateVendorPicBody,
  parseVendorPicIdParam,
  parseVendorPicVendorIdParam,
} from './vendor-pic.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createVendorPicHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorPicVendorIdParam(
      paramString(req.params.vendorId),
    );
    const input = parseCreateVendorPicBody(req.body);
    const pic = await vendorPicService.createVendorPic({ ...input, vendorId });
    sendSuccess(res, pic, 201);
  } catch (error) {
    next(error);
  }
}

export async function listVendorPicsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorPicVendorIdParam(
      paramString(req.params.vendorId),
    );
    const pics = await vendorPicService.listVendorPicsByVendor(vendorId);
    sendSuccess(res, pics);
  } catch (error) {
    next(error);
  }
}

export async function getVendorPicHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorPicIdParam(paramString(req.params.id));
    const pic = await vendorPicService.getVendorPicById(id);
    sendSuccess(res, pic);
  } catch (error) {
    next(error);
  }
}

export async function updateVendorPicHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorPicIdParam(paramString(req.params.id));
    const input = parseUpdateVendorPicBody(req.body);
    const pic = await vendorPicService.updateVendorPic(id, input);
    sendSuccess(res, pic);
  } catch (error) {
    next(error);
  }
}
