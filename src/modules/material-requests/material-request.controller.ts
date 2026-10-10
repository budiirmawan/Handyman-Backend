import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { materialRequestService } from './material-request.service';
import {
  parseBuildingIdParam,
  parseCreateMaterialRequestBody,
  parseItemIdParam,
  parseMaterialRequestFilters,
  parseMaterialRequestIdParam,
  parsePurchaseRequestIdParam,
  parseUpdateMaterialRequestBody,
} from './material-request.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * `POST /purchase-requests/:purchaseRequestId/material-requests`. The
 * requester is derived from the authenticated session. Building isolation is
 * enforced by the actor-facing service's scoped parent resolution.
 */
export async function createMaterialRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const purchaseRequestId = parsePurchaseRequestIdParam(
      paramString(req.params.purchaseRequestId),
    );
    const input = parseCreateMaterialRequestBody(req.body);

    const materialRequest = await materialRequestService.createMaterialRequestForActor({
      ...input,
      purchaseRequestId,
      requestedByUserId: req.auth.userId,
    }, req.auth.userId);
    sendSuccess(res, materialRequest, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /purchase-requests/:purchaseRequestId/material-requests` — lists the
 * Material Requests of one Purchase Request, enforcing Building isolation on
 * the Purchase Request.
 */
export async function listByPurchaseRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const purchaseRequestId = parsePurchaseRequestIdParam(
      paramString(req.params.purchaseRequestId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filters = parseMaterialRequestFilters(req.query);
    const materialRequests = await materialRequestService.listMaterialRequestsByPurchaseRequestForActor(
      purchaseRequestId, filters, req.auth.userId,
    );
    sendSuccess(res, materialRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /buildings/:buildingId/material-requests` — lists Material Requests for
 * a Building. `?status=`, `?purchaseRequestId=`, and `?itemId=` filters are
 * supported. Building isolation is enforced by `requireBuildingAccess` at the
 * route level.
 */
export async function listByBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(
      paramString(req.params.buildingId),
    );
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseMaterialRequestFilters(req.query);
    const materialRequests =
      await materialRequestService.listMaterialRequestsByBuildingForActor(
        buildingId,
        filters,
        req.auth.userId,
      );
    sendSuccess(res, materialRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /items/:itemId/material-requests` — lists Material Requests referencing
 * one Item. The service resolves the actor's explicit BE-02G contexts before
 * item lookup; the repository intersects every row with that scope in SQL.
 */
export async function listByItemHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const itemId = parseItemIdParam(paramString(req.params.itemId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filters = parseMaterialRequestFilters(req.query);
    const materialRequests = await materialRequestService.listMaterialRequestsByItem(
      itemId,
      filters,
      req.auth.userId,
    );

    sendSuccess(res, materialRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /material-requests/:id` applies exact scoped SQL resolution before
 * enrichment, with uniform missing/inaccessible responses.
 */
export async function getMaterialRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseMaterialRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const materialRequest = await materialRequestService.getMaterialRequestByIdForActor(id, req.auth.userId);

    sendSuccess(res, materialRequest);
  } catch (error) {
    next(error);
  }
}

export async function updateMaterialRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseMaterialRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateMaterialRequestBody(req.body);

    const materialRequest = await materialRequestService.updateMaterialRequestForActor(
      id, input, req.auth.userId,
    );
    sendSuccess(res, materialRequest);
  } catch (error) {
    next(error);
  }
}

export async function cancelMaterialRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseMaterialRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const materialRequest = await materialRequestService.cancelMaterialRequestForActor(
      id, req.auth.userId,
    );
    sendSuccess(res, materialRequest);
  } catch (error) {
    next(error);
  }
}
