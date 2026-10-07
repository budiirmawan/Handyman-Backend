import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  evaluateHandymanArrivalVerification,
  getHandymanArrivalVerificationByScope,
} from '../handyman-arrival-results';
import type { PublicHandymanArrivalVerificationResult }
  from '../handyman-arrival-results';
import {
  parseArrivalScopeParam,
  parseArrivalVerificationBody,
} from './handyman-arrival-verification-api.validation';

/**
 * CR-HM-07 PART 04C — terminal arrival-verification HTTP handler
 * (THIN shell). The handler does EXACTLY: auth/context → bounded
 * request validation → PART 04B evaluator call → serialize immutable
 * result. ZERO QR/geofence/challenge/actor decision logic here —
 * PART 04B remains the sole authority. NO API.CO.ID call, NO
 * work-session/check-in/attendance/payment/BAST/FM handler.

 * Response serialization is BOUNDED: caller-supplied authority values
 * (token hash, challenge token, internal assignment/policy ids beyond
 * the contract, client binding ids) never cross the response surface.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

/** Bounded response DTO (OpenAPI contract; internal ids + secrets omitted). */
export type ArrivalVerificationResponse = {
  id: string;
  executionScopeId: string;
  challengeId: string;
  status: PublicHandymanArrivalVerificationResult['status'];
  primaryReason: string;
  qrSignal: string;
  geofenceSignal:
    PublicHandymanArrivalVerificationResult['geofenceSignal'];
  distanceMeters: number | null;
  evaluatedAt: string;
};

function toResponse(
  result: PublicHandymanArrivalVerificationResult,
): ArrivalVerificationResponse {
  return {
    id: result.id,
    executionScopeId: result.executionScopeId,
    challengeId: result.challengeId,
    status: result.status,
    primaryReason: result.primaryReason,
    qrSignal: result.qrSignal,
    geofenceSignal: result.geofenceSignal,
    distanceMeters: result.distanceMeters,
    evaluatedAt: result.evaluatedAt.toISOString(),
  };
}

export async function postHandymanArrivalVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseArrivalScopeParam(
      p(req.params.executionScopeId),
    );
    const input = parseArrivalVerificationBody(req.body);
    sendSuccess(
      res,
      toResponse(await evaluateHandymanArrivalVerification(
        { executionScopeId, ...input },
        actor(req),
      )),
      200,
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanArrivalVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseArrivalScopeParam(
      p(req.params.executionScopeId),
    );
    sendSuccess(
      res,
      await getHandymanArrivalVerificationByScope(
        executionScopeId,
        actor(req),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}
