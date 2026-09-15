import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { utilityVerificationService } from './utility-verification.service';
import {
  parseAbnormalConsumptionIdParam,
  parseOpenUtilityVerificationBody,
  parseSubmitUtilityVerificationBody,
} from './utility-verification.validation';

/** BE-18K — Utility Verification HTTP handlers. */

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** GET /utility/abnormal-consumptions/:id/verification — context + state. */
export async function getVerificationContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAbnormalConsumptionIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const state = await utilityVerificationService.getUtilityVerificationContext(
      id,
      req.auth.userId,
    );
    sendSuccess(res, state);
  } catch (error) {
    next(error);
  }
}

/** POST /utility/abnormal-consumptions/:id/verification/open */
export async function openVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAbnormalConsumptionIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseOpenUtilityVerificationBody(req.body);
    const state = await utilityVerificationService.openUtilityVerification(
      {
        abnormalConsumptionId: id,
        reviewerUserId: body.reviewerUserId ?? req.auth.userId,
        notes: body.notes ?? null,
      },
      req.auth.userId,
    );
    sendSuccess(res, state, 201);
  } catch (error) {
    next(error);
  }
}

/** POST /utility/abnormal-consumptions/:id/verification — submit a decision. */
export async function submitVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAbnormalConsumptionIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseSubmitUtilityVerificationBody(req.body);
    const state = await utilityVerificationService.submitUtilityVerification(
      {
        abnormalConsumptionId: id,
        decision: body.decision,
        reviewerUserId: req.auth.userId,
        notes: body.notes ?? null,
      },
      req.auth.userId,
    );
    sendSuccess(res, state, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/abnormal-consumptions/:id/verification/latest */
export async function getLatestVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAbnormalConsumptionIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const latest = await utilityVerificationService.getLatestUtilityVerification(
      id,
      req.auth.userId,
    );
    sendSuccess(res, latest);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/abnormal-consumptions/:id/verifications — full history. */
export async function listVerificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAbnormalConsumptionIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const items = await utilityVerificationService.listUtilityVerifications(
      id,
      req.auth.userId,
    );
    sendSuccess(res, items, 200, { total: items.length });
  } catch (error) {
    next(error);
  }
}
