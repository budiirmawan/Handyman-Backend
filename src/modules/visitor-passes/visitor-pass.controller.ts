import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { visitorPassService } from './visitor-pass.service';
import {
  parseIssueVisitorPassBody,
  parseReturnVisitorPassBody,
  parseVisitorPassIdParam,
  parseVisitorPassListQuery,
} from './visitor-pass.validation';

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** POST /visitor-passes — issues a pass for an active checked-in visit. */
export async function issueVisitorPassHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseIssueVisitorPassBody(req.body);
    const result = await visitorPassService.issueVisitorPass(
      { ...body, issuedByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /visitor-passes?buildingId=&status=&visitCheckInId= */
export async function listVisitorPassesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseVisitorPassListQuery(
      req.query as Record<string, unknown>,
    );
    const result = await visitorPassService.listVisitorPasses(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** GET /visitor-passes/:id */
export async function getVisitorPassHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorPassIdParam(paramString(req.params.id));
    const result = await visitorPassService.getVisitorPass(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /visitor-passes/:id/return */
export async function returnVisitorPassHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorPassIdParam(paramString(req.params.id));
    const body = parseReturnVisitorPassBody(req.body);
    const result = await visitorPassService.returnVisitorPass(
      id,
      { ...body, returnedByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /visitor-passes/:id/cancel */
export async function cancelVisitorPassHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseVisitorPassIdParam(paramString(req.params.id));
    const result = await visitorPassService.cancelVisitorPass(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
