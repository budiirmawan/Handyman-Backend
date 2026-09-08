import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorWorkforceService } from './vendor-workforce.service';
import {
  parseCreateVendorWorkforceBindingBody,
  parseUpdateVendorWorkforceBindingBody,
  parseVendorIdParam,
  parseWorkforceIdParam,
} from './vendor-workforce.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createVendorWorkforceBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorIdParam(paramString(req.params.vendorId));
    const input = parseCreateVendorWorkforceBindingBody(req.body);
    const binding = await vendorWorkforceService.createVendorWorkforceBinding({
      ...input,
      vendorId,
    });
    sendSuccess(res, binding, 201);
  } catch (error) {
    next(error);
  }
}

export async function listVendorWorkforceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorIdParam(paramString(req.params.vendorId));
    const bindings = await vendorWorkforceService.listVendorWorkforce(vendorId);
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

export async function listWorkforceVendorBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const bindings =
      await vendorWorkforceService.listWorkforceVendorBindings(workforceId);
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

export async function updateVendorWorkforceBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorIdParam(paramString(req.params.vendorId));
    const workforceId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const input = parseUpdateVendorWorkforceBindingBody(req.body);
    const binding = await vendorWorkforceService.updateVendorWorkforceBinding(
      vendorId,
      workforceId,
      input,
    );
    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}
