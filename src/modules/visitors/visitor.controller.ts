import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { visitorService } from './visitor.service';
import {
  parseCreateVisitorBody,
  parseUpdateVisitorBody,
  parseVisitorClientIdParam,
  parseVisitorIdParam,
  parseVisitorListQuery,
} from './visitor.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /clients/:clientId/visitors
 *
 * Registers a new shared Visitor identity for the Client. Duplicate
 * identity documents (identity type + identity number) are rejected —
 * the caller should reuse the existing visitor identity instead.
 */
export async function createVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const clientId = parseVisitorClientIdParam(paramString(req.params.clientId));
    const body = parseCreateVisitorBody(req.body);
    const result = await visitorService.createVisitor(
      { ...body, clientId, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /clients/:clientId/visitors
 *   ?search=&identityType=&identityNumber=&phone=&email=&status=
 */
export async function listVisitorsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const clientId = parseVisitorClientIdParam(paramString(req.params.clientId));
    const filters = parseVisitorListQuery(req.query as Record<string, unknown>);
    const results = await visitorService.listVisitors(
      clientId,
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /visitors/:id */
export async function getVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorIdParam(paramString(req.params.id));
    const result = await visitorService.getVisitor(id, req.auth.userId);
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** PATCH /visitors/:id */
export async function updateVisitorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorIdParam(paramString(req.params.id));
    const body = parseUpdateVisitorBody(req.body);
    const result = await visitorService.updateVisitor(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
