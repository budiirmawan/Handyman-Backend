import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { workRequestService } from './work-request.service';
import {
  parseCreateWorkRequestBody,
  parseUpdateWorkRequestBody,
  parseWorkRequestBuildingIdParam,
  parseWorkRequestFilters,
  parseWorkRequestIdParam,
} from './work-request.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * `POST /buildings/:buildingId/work-requests`. The requester is derived from
 * the authenticated session — never supplied by the client — so the requester
 * is always a valid, authenticated user and cannot be spoofed.
 */
export async function createWorkRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const buildingId = parseWorkRequestBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreateWorkRequestBody(req.body);
    const workRequest = await workRequestService.createWorkRequest({
      ...input,
      buildingId,
      requestedByUserId: req.auth.userId,
    });
    sendSuccess(res, workRequest, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingWorkRequestsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseWorkRequestBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const filters = parseWorkRequestFilters(req.query);
    const workRequests =
      await workRequestService.listWorkRequestsByBuilding(buildingId, filters);
    sendSuccess(res, workRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /work-requests/:id` carries no `buildingId` route parameter, so BE-02
 * Building isolation is enforced here instead of via `requireBuildingAccess`:
 * the request is loaded first (unknown id → 404), then the caller must hold an
 * ACTIVE assignment to its Building (otherwise 403 BUILDING_ACCESS_DENIED).
 * Permission alone is never enough.
 */
export async function getWorkRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const workRequest = await workRequestService.getWorkRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      workRequest.buildingId,
    );

    sendSuccess(res, workRequest);
  } catch (error) {
    next(error);
  }
}

export async function updateWorkRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateWorkRequestBody(req.body);

    const existing = await workRequestService.getWorkRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const workRequest = await workRequestService.updateWorkRequest(id, input);
    sendSuccess(res, workRequest);
  } catch (error) {
    next(error);
  }
}

export async function cancelWorkRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await workRequestService.getWorkRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const workRequest = await workRequestService.cancelWorkRequest(id);
    sendSuccess(res, workRequest);
  } catch (error) {
    next(error);
  }
}
