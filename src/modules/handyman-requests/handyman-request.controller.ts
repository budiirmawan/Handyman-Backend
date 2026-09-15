import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  cancelHandymanRequest,
  createHandymanRequest,
  getHandymanRequestById,
  listHandymanRequests,
} from './handyman-request.service';
import {
  parseCreateHandymanRequestHttpBody,
  parseHandymanRequestBuildingIdParam,
  parseHandymanRequestFilters,
  parseHandymanRequestIdParam,
} from './handyman-request.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function idempotencyHeader(req: Request): string | undefined {
  const value = req.header('Idempotency-Key');
  return value?.trim() || undefined;
}

/**
 * CR-HM-BE-01 RUN 3 — Handyman Request HTTP handlers.
 *
 * Thin transport over the Run 2 service authority: the building scope comes
 * from the route, the actor only from req.auth, and the optional
 * Idempotency-Key header is forwarded to the existing service. No business
 * rules live here.
 */
export async function createHandymanRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseHandymanRequestBuildingIdParam(
      param(req.params.buildingId),
    );
    const body = parseCreateHandymanRequestHttpBody(req.body);
    sendSuccess(
      res,
      await createHandymanRequest(
        { ...body, buildingId, idempotencyKey: idempotencyHeader(req) },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listBuildingHandymanRequestsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseHandymanRequestBuildingIdParam(
      param(req.params.buildingId),
    );
    // The route building is the authoritative scope; a buildingId query
    // parameter can never widen it.
    const filters = parseHandymanRequestFilters({
      ...req.query,
      buildingId,
    });
    sendSuccess(res, await listHandymanRequests(filters, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getHandymanRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHandymanRequestIdParam(param(req.params.handymanRequestId));
    sendSuccess(res, await getHandymanRequestById(id, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function cancelHandymanRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHandymanRequestIdParam(param(req.params.handymanRequestId));
    sendSuccess(res, await cancelHandymanRequest(id, actor(req)));
  } catch (error) {
    next(error);
  }
}
