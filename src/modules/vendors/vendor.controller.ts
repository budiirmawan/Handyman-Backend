import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorService } from './vendor.service';
import {
  parseCreateVendorBody,
  parseUpdateVendorBody,
  parseVendorClientIdParam,
  parseVendorIdParam,
} from './vendor.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createVendorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseVendorClientIdParam(paramString(req.params.clientId));
    const input = parseCreateVendorBody(req.body);
    const vendor = await vendorService.createVendor({ ...input, clientId });
    sendSuccess(res, vendor, 201);
  } catch (error) {
    next(error);
  }
}

export async function listClientVendorsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseVendorClientIdParam(paramString(req.params.clientId));
    const vendors = await vendorService.listVendorsByClient(clientId);
    sendSuccess(res, vendors);
  } catch (error) {
    next(error);
  }
}

export async function getVendorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorIdParam(paramString(req.params.id));
    const vendor = await vendorService.getVendorById(id);
    sendSuccess(res, vendor);
  } catch (error) {
    next(error);
  }
}

export async function updateVendorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorIdParam(paramString(req.params.id));
    const input = parseUpdateVendorBody(req.body);
    const vendor = await vendorService.updateVendor(id, input);
    sendSuccess(res, vendor);
  } catch (error) {
    next(error);
  }
}
