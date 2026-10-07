import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { visitCheckInService } from './visit-check-in.service';
import {
  parseCheckOutVisitBody,
  parseCreateVisitCheckInBody,
  parseVisitCheckInIdParam,
  parseVisitCheckInListQuery,
} from './visit-check-in.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /visit-check-ins
 *
 * Checks in an Expected Visitor (BE-13C) or Walk-In (BE-13D) visit.
 * Building / Client / visitor identity derive from the visit; an
 * existing BE-13F host confirmation must be CONFIRMED.
 */
export async function checkInVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateVisitCheckInBody(req.body);
    const result = await visitCheckInService.checkInVisit(
      { ...body, checkedInByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /visit-check-ins
 *   ?buildingId=&visitorId=&expectedVisitorId=&walkInVisitId=&status=
 *   &checkedInFrom=&checkedInTo=
 *
 * `status=CHECKED_IN` with a `buildingId` yields the current
 * checked-in visitor list for a Building.
 */
export async function listVisitCheckInsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseVisitCheckInListQuery(
      req.query as Record<string, unknown>,
    );
    const results = await visitCheckInService.listVisitCheckIns(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /visit-check-ins/:id */
export async function getVisitCheckInHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitCheckInIdParam(paramString(req.params.id));
    const result = await visitCheckInService.getVisitCheckIn(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /visit-check-ins/:id/check-out
 *
 * BE-13H — closes an actively checked-in visit. Preserves the
 * original check-in history on the same row; duplicate check-out is
 * rejected.
 */
export async function checkOutVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitCheckInIdParam(paramString(req.params.id));
    const body = parseCheckOutVisitBody(req.body);
    const result = await visitCheckInService.checkOutVisit(
      id,
      { ...body, checkedOutByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /visit-check-ins/:id/cancel
 *
 * Reverses a mistaken check-in (front-desk correction). The visit
 * becomes eligible for a fresh check-in.
 */
export async function cancelVisitCheckInHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitCheckInIdParam(paramString(req.params.id));
    const result = await visitCheckInService.cancelVisitCheckIn(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
