import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { walkInVisitService } from './walk-in-visit.service';
import {
  parseCreateWalkInVisitBody,
  parseUpdateWalkInVisitBody,
  parseWalkInVisitIdParam,
  parseWalkInVisitListQuery,
} from './walk-in-visit.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /walk-in-visits
 *
 * Registers a front-desk guest-book entry. Exactly one of `visitorId`
 * (reuse an existing BE-13A identity) or `newVisitor` (register a new
 * identity inline through BE-13A) must be supplied.
 */
export async function createWalkInVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateWalkInVisitBody(req.body);
    const result = await walkInVisitService.createWalkInVisit(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /walk-in-visits
 *   ?buildingId=&visitorId=&hostUserId=&status=&arrivedFrom=&arrivedTo=
 */
export async function listWalkInVisitsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseWalkInVisitListQuery(
      req.query as Record<string, unknown>,
    );
    const results = await walkInVisitService.listWalkInVisits(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /walk-in-visits/:id */
export async function getWalkInVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseWalkInVisitIdParam(paramString(req.params.id));
    const result = await walkInVisitService.getWalkInVisit(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** PATCH /walk-in-visits/:id */
export async function updateWalkInVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseWalkInVisitIdParam(paramString(req.params.id));
    const body = parseUpdateWalkInVisitBody(req.body);
    const result = await walkInVisitService.updateWalkInVisit(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /walk-in-visits/:id/cancel */
export async function cancelWalkInVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseWalkInVisitIdParam(paramString(req.params.id));
    const result = await walkInVisitService.cancelWalkInVisit(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
