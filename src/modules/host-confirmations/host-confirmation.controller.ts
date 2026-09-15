import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { hostConfirmationService } from './host-confirmation.service';
import {
  parseConfirmHostConfirmationBody,
  parseCreateHostConfirmationBody,
  parseHostConfirmationIdParam,
  parseHostConfirmationListQuery,
  parseRejectHostConfirmationBody,
} from './host-confirmation.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/**
 * POST /host-confirmations
 *
 * Requests (stores) a PENDING host confirmation for an existing
 * BE-13C Expected Visitor or BE-13D Walk-In visit. Host context
 * defaults from the visit record.
 */
export async function requestHostConfirmationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const body = parseCreateHostConfirmationBody(req.body);
    const result = await hostConfirmationService.requestHostConfirmation(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /host-confirmations
 *   ?buildingId=&expectedVisitorId=&walkInVisitId=&hostUserId=&status=
 */
export async function listHostConfirmationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseHostConfirmationListQuery(
      req.query as Record<string, unknown>,
    );
    const results = await hostConfirmationService.listHostConfirmations(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

/** GET /host-confirmations/:id */
export async function getHostConfirmationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseHostConfirmationIdParam(paramString(req.params.id));
    const result = await hostConfirmationService.getHostConfirmation(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /host-confirmations/:id/confirm — single-shot decision. */
export async function confirmVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseHostConfirmationIdParam(paramString(req.params.id));
    const body = parseConfirmHostConfirmationBody(req.body);
    const result = await hostConfirmationService.confirmVisit(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** POST /host-confirmations/:id/reject — single-shot decision. */
export async function rejectVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const id = parseHostConfirmationIdParam(paramString(req.params.id));
    const body = parseRejectHostConfirmationBody(req.body);
    const result = await hostConfirmationService.rejectVisit(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
