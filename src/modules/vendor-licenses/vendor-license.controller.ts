import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorLicenseNotFoundError } from './vendor-license.errors';
import { vendorLicenseService } from './vendor-license.service';
import {
  parseCreateVendorLicenseBody,
  parseUpdateVendorLicenseBody,
  parseVendorLicenseIdParam,
  parseVendorLicenseVendorIdParam,
} from './vendor-license.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createVendorLicenseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorLicenseVendorIdParam(
      paramString(req.params.vendorId),
    );
    const input = parseCreateVendorLicenseBody(req.body);
    const license = await vendorLicenseService.createVendorLicense({
      ...input,
      vendorId,
    });
    sendSuccess(res, license, 201);
  } catch (error) {
    next(error);
  }
}

export async function listVendorLicensesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorLicenseVendorIdParam(
      paramString(req.params.vendorId),
    );
    const licenses =
      await vendorLicenseService.listVendorLicensesByVendor(vendorId);
    sendSuccess(res, licenses);
  } catch (error) {
    next(error);
  }
}

export async function listCurrentVendorLicensesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorId = parseVendorLicenseVendorIdParam(
      paramString(req.params.vendorId),
    );
    const licenses =
      await vendorLicenseService.listCurrentVendorLicenses(vendorId);
    sendSuccess(res, licenses);
  } catch (error) {
    next(error);
  }
}

export async function updateVendorLicenseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The vendor param scopes the route; the record is addressed by id.
    const vendorId = parseVendorLicenseVendorIdParam(
      paramString(req.params.vendorId),
    );
    const id = parseVendorLicenseIdParam(paramString(req.params.id));
    const input = parseUpdateVendorLicenseBody(req.body);

    // Route/record consistency: the record must belong to the addressed
    // vendor (404 otherwise, without leaking the true owner).
    const existing = await vendorLicenseService.getVendorLicenseById(id);
    if (existing.vendorId !== vendorId) {
      throw vendorLicenseNotFoundError();
    }

    const license = await vendorLicenseService.updateVendorLicense(id, input);
    sendSuccess(res, license);
  } catch (error) {
    next(error);
  }
}
