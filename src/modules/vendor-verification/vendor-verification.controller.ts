import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { vendorVerificationService } from './vendor-verification.service';
import {
  parseVendorVerificationBody,
  parseVendorWorkIdParam,
} from './vendor-verification.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** GET /vendor-works/:id/verification — context + latest + history. */
export async function getVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorWorkId = parseVendorWorkIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const state = await vendorVerificationService.getVendorVerificationState(
      vendorWorkId,
      req.auth.userId,
    );
    sendSuccess(res, state);
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-works/:id/verification — submit a decision. */
export async function submitVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendorWorkId = parseVendorWorkIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const input = parseVendorVerificationBody(req.body);
    const result = await vendorVerificationService.submitVendorVerification({
      ...input,
      vendorWorkId,
      reviewerUserId: req.auth.userId,
    });
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}
