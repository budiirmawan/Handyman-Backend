import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { expectedVisitorService } from './expected-visitor.service';
import {
  parseCreateExpectedVisitorBody,
  parseExpectedVisitorIdParam,
  parseExpectedVisitorListQuery,
  parseUpdateExpectedVisitorBody,
} from './expected-visitor.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /expected-visitors
 *
 * Creates a front-desk expectation. Either standalone (buildingId,
 * visitorId, expectedArrivalAt and purpose required) or from a PENDING
 * BE-13B invitation (fields default from the invitation).
 */
export async function createExpectedVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateExpectedVisitorBody(req.body);
    const result = await expectedVisitorService.createExpectedVisitor(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /expected-visitors
 *   ?buildingId=&visitorId=&visitorInvitationId=&hostUserId=&status=
 *   &expectedFrom=&expectedTo=
 */
export async function listExpectedVisitorsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseExpectedVisitorListQuery(
      req.query as Record<string, unknown>,
    );
    const results = await expectedVisitorService.listExpectedVisitors(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /expected-visitors/:id */
export async function getExpectedVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseExpectedVisitorIdParam(paramString(req.params.id));
    const result = await expectedVisitorService.getExpectedVisitor(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** PATCH /expected-visitors/:id */
export async function updateExpectedVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseExpectedVisitorIdParam(paramString(req.params.id));
    const body = parseUpdateExpectedVisitorBody(req.body);
    const result = await expectedVisitorService.updateExpectedVisitor(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /expected-visitors/:id/cancel */
export async function cancelExpectedVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseExpectedVisitorIdParam(paramString(req.params.id));
    const result = await expectedVisitorService.cancelExpectedVisitor(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
