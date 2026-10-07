import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { purchaseRequestService } from '../purchase-requests';
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
 * enforced by resolving the Purchase Request's Building and asserting the
 * caller holds an ACTIVE assignment.
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

    const purchaseRequest = await purchaseRequestService.getPurchaseRequestById(
      purchaseRequestId,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      purchaseRequest.buildingId,
    );

    const materialRequest = await materialRequestService.createMaterialRequest({
      ...input,
      purchaseRequestId,
      requestedByUserId: req.auth.userId,
    });
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
    const purchaseRequest = await purchaseRequestService.getPurchaseRequestById(
      purchaseRequestId,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      purchaseRequest.buildingId,
    );

    const materialRequests =
      await materialRequestService.listMaterialRequestsByPurchaseRequest(
        purchaseRequestId,
        filters,
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
    const filters = parseMaterialRequestFilters(req.query);
    const materialRequests =
      await materialRequestService.listMaterialRequestsByBuilding(
        buildingId,
        filters,
      );
    sendSuccess(res, materialRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /items/:itemId/material-requests` — lists Material Requests referencing
 * one Item. An Item is Client-scoped, not Building-scoped, so Building
 * isolation is enforced here by deriving an accessible Building from the first
 * returned request; a caller without access to any such Building receives 403.
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
    );

    const anyBuildingId = materialRequests[0]?.buildingId;
    if (anyBuildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        anyBuildingId,
      );
    }

    sendSuccess(res, materialRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /material-requests/:id` carries no Building route parameter, so BE-02
 * Building isolation is enforced here after resolving the record's Building.
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

    const materialRequest = await materialRequestService.getMaterialRequestById(
      id,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      materialRequest.buildingId,
    );

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

    const existing = await materialRequestService.getMaterialRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const materialRequest = await materialRequestService.updateMaterialRequest(
      id,
      input,
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

    const existing = await materialRequestService.getMaterialRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const materialRequest = await materialRequestService.cancelMaterialRequest(
      id,
    );
    sendSuccess(res, materialRequest);
  } catch (error) {
    next(error);
  }
}
