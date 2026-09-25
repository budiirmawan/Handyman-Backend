import type { NextFunction, Request, Response } from 'express';
import { authenticationRequiredError } from '../auth';
import { sendSuccess } from '../../shared/api-response';
import {
  parseCreateSafetyInspectionBindingBody,
  parseSafetyInspectionBindingIdParam,
  parseUpdateSafetyInspectionBindingBody,
} from './safety-inspection-binding.validation';
import { safetyInspectionBindingService } from './safety-inspection-binding.service';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createSafetyInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const input = parseCreateSafetyInspectionBindingBody(
      req.body as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await safetyInspectionBindingService.createSafetyInspectionBinding(
        input,
        req.auth.userId,
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getSafetyInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSafetyInspectionBindingIdParam(
      paramString(req.params.id),
    );
    sendSuccess(
      res,
      await safetyInspectionBindingService.getSafetyInspectionBinding(
        id,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateSafetyInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseSafetyInspectionBindingIdParam(
      paramString(req.params.id),
    );
    const input = parseUpdateSafetyInspectionBindingBody(
      req.body as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await safetyInspectionBindingService.updateSafetyInspectionBinding(
        id,
        input,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
