import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorCapabilityService } from './vendor-capability.service';
import {
  parseCreateVendorCapabilityBody,
  parseUpdateVendorCapabilityBody,
  parseVendorCapabilityIdParam,
  parseVendorCapabilityVendorIdParam,
} from './vendor-capability.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createVendorCapabilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorCapabilityVendorIdParam(
      paramString(req.params.vendorId),
    );
    const input = parseCreateVendorCapabilityBody(req.body);
    const capability = await vendorCapabilityService.createVendorCapability({
      ...input,
      vendorId,
    });
    sendSuccess(res, capability, 201);
  } catch (error) {
    next(error);
  }
}

export async function listVendorCapabilitiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorCapabilityVendorIdParam(
      paramString(req.params.vendorId),
    );
    const capabilities =
      await vendorCapabilityService.listVendorCapabilitiesByVendor(vendorId);
    sendSuccess(res, capabilities);
  } catch (error) {
    next(error);
  }
}

export async function getVendorCapabilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorCapabilityIdParam(paramString(req.params.id));
    const capability =
      await vendorCapabilityService.getVendorCapabilityById(id);
    sendSuccess(res, capability);
  } catch (error) {
    next(error);
  }
}

export async function updateVendorCapabilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorCapabilityIdParam(paramString(req.params.id));
    const input = parseUpdateVendorCapabilityBody(req.body);
    const capability = await vendorCapabilityService.updateVendorCapability(
      id,
      input,
    );
    sendSuccess(res, capability);
  } catch (error) {
    next(error);
  }
}
