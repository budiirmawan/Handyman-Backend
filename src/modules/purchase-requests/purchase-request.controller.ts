import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { purchaseRequestService } from './purchase-request.service';
import {
  parseCreatePurchaseRequestBody,
  parsePurchaseRequestBuildingIdParam,
  parsePurchaseRequestFilters,
  parsePurchaseRequestIdParam,
  parseUpdatePurchaseRequestBody,
} from './purchase-request.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * `POST /buildings/:buildingId/purchase-requests`. The requester is derived
 * from the authenticated session — never supplied by the client — so the
 * requester is always a valid, authenticated user and cannot be spoofed.
 */
export async function createPurchaseRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const buildingId = parsePurchaseRequestBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreatePurchaseRequestBody(req.body);
    const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
      ...input,
      buildingId,
      requestedByUserId: req.auth.userId,
    });
    sendSuccess(res, purchaseRequest, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingPurchaseRequestsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parsePurchaseRequestBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const filters = parsePurchaseRequestFilters(req.query);
    const purchaseRequests =
      await purchaseRequestService.listPurchaseRequestsByBuilding(
        buildingId,
        filters,
      );
    sendSuccess(res, purchaseRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /purchase-requests/:id` carries no `buildingId` route parameter, so
 * BE-02 Building isolation is enforced here instead of via
 * `requireBuildingAccess`: the request is loaded first (unknown id → 404),
 * then the caller must hold an ACTIVE assignment to its Building (otherwise
 * 403 BUILDING_ACCESS_DENIED). Permission alone is never enough.
 */
export async function getPurchaseRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePurchaseRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const purchaseRequest = await purchaseRequestService.getPurchaseRequestById(
      id,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      purchaseRequest.buildingId,
    );

    sendSuccess(res, purchaseRequest);
  } catch (error) {
    next(error);
  }
}

export async function updatePurchaseRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePurchaseRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdatePurchaseRequestBody(req.body);

    const existing = await purchaseRequestService.getPurchaseRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const purchaseRequest = await purchaseRequestService.updatePurchaseRequest(
      id,
      input,
    );
    sendSuccess(res, purchaseRequest);
  } catch (error) {
    next(error);
  }
}

export async function cancelPurchaseRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePurchaseRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await purchaseRequestService.getPurchaseRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const purchaseRequest = await purchaseRequestService.cancelPurchaseRequest(
      id,
    );
    sendSuccess(res, purchaseRequest);
  } catch (error) {
    next(error);
  }
}
