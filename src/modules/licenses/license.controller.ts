import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { licenseService } from './license.service';
import {
  parseCreateLicenseBody,
  parseLicenseIdParam,
  parseLicenseSubscriptionIdParam,
  parseUpdateLicenseStatusBody,
} from './license.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createLicenseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseLicenseSubscriptionIdParam(
      paramString(req.params.subscriptionId),
    );
    const input = parseCreateLicenseBody(req.body);
    const license = await licenseService.createLicense(subscriptionId, input);
    sendSuccess(res, license, 201);
  } catch (error) {
    next(error);
  }
}

export async function listLicensesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseLicenseSubscriptionIdParam(
      paramString(req.params.subscriptionId),
    );
    const licenses = await licenseService.listLicensesBySubscriptionId(subscriptionId);
    sendSuccess(res, licenses);
  } catch (error) {
    next(error);
  }
}

export async function getLicenseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseLicenseIdParam(paramString(req.params.id));
    const license = await licenseService.getLicenseById(id);
    sendSuccess(res, license);
  } catch (error) {
    next(error);
  }
}

export async function updateLicenseStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseLicenseIdParam(paramString(req.params.id));
    const input = parseUpdateLicenseStatusBody(req.body);
    const license = await licenseService.updateLicenseStatus(id, input);
    sendSuccess(res, license);
  } catch (error) {
    next(error);
  }
}

export async function getLicenseEffectiveStateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseLicenseIdParam(paramString(req.params.id));
    const state = await licenseService.getLicenseEffectiveState(id);
    sendSuccess(res, state);
  } catch (error) {
    next(error);
  }
}
