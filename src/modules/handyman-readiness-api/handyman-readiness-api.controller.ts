import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  handymanPermitReadinessService,
  handymanSchedulingReadinessService,
  handymanUnitAccessReadinessService,
} from '../handyman-scheduling';
import {
  parsePermitReadinessCreateBody,
  parsePermitReadinessSupersedeBody,
  parseReadinessApiUuidParam,
  parseSchedulingReadinessCreateBody,
  parseSchedulingReadinessSupersedeBody,
  parseUnitAccessReadinessCreateBody,
  parseUnitAccessReadinessSupersedeBody,
} from './handyman-readiness-api.validation';

/**
 * CR-HM-05 PART 06A — Handyman readiness HTTP handlers (FROZEN F7).
 *
 * Thin shells only: URL request/readiness ids + whitelisted body +
 * authenticated actor from `req.auth.userId`. PART 01–04 services remain
 * the sole authority for Client/location/timezone derivation,
 * one-ACTIVE semantics, supersede/history invariants and journaling.
 * ZERO target-binding, crew-assignment, arrival-verification, QR/
 * geofence or FM permit/work-order handlers exist here (PART 05 is
 * docs-only deferred).
 */

const p = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

const requestId = (req: Request) =>
  parseReadinessApiUuidParam(p(req.params.handymanRequestId), 'handymanRequestId');
const readinessId = (req: Request) =>
  parseReadinessApiUuidParam(p(req.params.readinessId), 'readinessId');

// -------- A. Scheduling readiness --------

/** POST /handyman/requests/:handymanRequestId/scheduling-readiness */
export async function postHandymanSchedulingReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseSchedulingReadinessCreateBody(req.body);
    const row = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        { ...input, handymanRequestId: requestId(req) },
        req.auth.userId,
      );
    sendSuccess(res, row, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/scheduling-readiness */
export async function getHandymanSchedulingReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bundle = await handymanSchedulingReadinessService
      .getHandymanSchedulingReadiness(requestId(req), req.auth.userId);
    sendSuccess(res, bundle, 200);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/scheduling-readiness/history */
export async function getHandymanSchedulingReadinessHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rows = await handymanSchedulingReadinessService
      .listHandymanSchedulingReadinessHistory(requestId(req), req.auth.userId);
    sendSuccess(res, rows, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/scheduling-readiness/:readinessId/supersede */
export async function postHandymanSchedulingReadinessSupersedeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseSchedulingReadinessSupersedeBody(req.body);
    const row = await handymanSchedulingReadinessService
      .supersedeHandymanSchedulingReadiness(
        readinessId(req),
        input,
        req.auth.userId,
      );
    sendSuccess(res, row, 201);
  } catch (error) {
    next(error);
  }
}

// -------- B. Unit access readiness --------

/** POST /handyman/requests/:handymanRequestId/unit-access-readiness */
export async function postHandymanUnitAccessReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseUnitAccessReadinessCreateBody(req.body);
    const row = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        { ...input, handymanRequestId: requestId(req) },
        req.auth.userId,
      );
    sendSuccess(res, row, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/unit-access-readiness */
export async function getHandymanUnitAccessReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bundle = await handymanUnitAccessReadinessService
      .getHandymanUnitAccessReadiness(requestId(req), req.auth.userId);
    sendSuccess(res, bundle, 200);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/unit-access-readiness/history */
export async function getHandymanUnitAccessReadinessHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rows = await handymanUnitAccessReadinessService
      .listHandymanUnitAccessReadinessHistory(requestId(req), req.auth.userId);
    sendSuccess(res, rows, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/unit-access-readiness/:readinessId/supersede */
export async function postHandymanUnitAccessReadinessSupersedeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseUnitAccessReadinessSupersedeBody(req.body);
    const row = await handymanUnitAccessReadinessService
      .supersedeHandymanUnitAccessReadiness(
        readinessId(req),
        input,
        req.auth.userId,
      );
    sendSuccess(res, row, 201);
  } catch (error) {
    next(error);
  }
}

// -------- C. Permit readiness --------

/** POST /handyman/requests/:handymanRequestId/permit-readiness */
export async function postHandymanPermitReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parsePermitReadinessCreateBody(req.body);
    const row = await handymanPermitReadinessService
      .createHandymanPermitReadiness(
        { ...input, handymanRequestId: requestId(req) },
        req.auth.userId,
      );
    sendSuccess(res, row, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/permit-readiness */
export async function getHandymanPermitReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bundle = await handymanPermitReadinessService
      .getHandymanPermitReadiness(requestId(req), req.auth.userId);
    sendSuccess(res, bundle, 200);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/permit-readiness/history */
export async function getHandymanPermitReadinessHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rows = await handymanPermitReadinessService
      .listHandymanPermitReadinessHistory(requestId(req), req.auth.userId);
    sendSuccess(res, rows, 200);
  } catch (error) {
    next(error);
  }
}

/** POST /handyman/permit-readiness/:readinessId/supersede */
export async function postHandymanPermitReadinessSupersedeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parsePermitReadinessSupersedeBody(req.body);
    const row = await handymanPermitReadinessService
      .supersedeHandymanPermitReadiness(
        readinessId(req),
        input,
        req.auth.userId,
      );
    sendSuccess(res, row, 201);
  } catch (error) {
    next(error);
  }
}
