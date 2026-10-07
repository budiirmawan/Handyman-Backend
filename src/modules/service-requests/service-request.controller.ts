import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { purchaseRequestService } from '../purchase-requests';
import { serviceRequestService } from './service-request.service';
import {
  parseBuildingIdParam,
  parseCreateServiceRequestBody,
  parsePurchaseRequestIdParam,
  parseServiceRequestFilters,
  parseServiceRequestIdParam,
  parseUpdateServiceRequestBody,
} from './service-request.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * `POST /purchase-requests/:purchaseRequestId/service-requests`. The requester
 * is derived from the authenticated session. Building isolation is enforced by
 * resolving the Purchase Request's Building and asserting the caller holds an
 * ACTIVE assignment.
 */
export async function createServiceRequestHandler(
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
    const input = parseCreateServiceRequestBody(req.body);

    const purchaseRequest = await purchaseRequestService.getPurchaseRequestById(
      purchaseRequestId,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      purchaseRequest.buildingId,
    );

    const serviceRequest = await serviceRequestService.createServiceRequest({
      ...input,
      purchaseRequestId,
      requestedByUserId: req.auth.userId,
    });
    sendSuccess(res, serviceRequest, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /purchase-requests/:purchaseRequestId/service-requests` — lists the
 * Service Requests of one Purchase Request, enforcing Building isolation on the
 * Purchase Request.
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

    const filters = parseServiceRequestFilters(req.query);
    const purchaseRequest = await purchaseRequestService.getPurchaseRequestById(
      purchaseRequestId,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      purchaseRequest.buildingId,
    );

    const serviceRequests =
      await serviceRequestService.listServiceRequestsByPurchaseRequest(
        purchaseRequestId,
        filters,
      );
    sendSuccess(res, serviceRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /buildings/:buildingId/service-requests` — lists Service Requests for a
 * Building. `?status=`, `?purchaseRequestId=`, and `?serviceType=` filters are
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
    const filters = parseServiceRequestFilters(req.query);
    const serviceRequests =
      await serviceRequestService.listServiceRequestsByBuilding(
        buildingId,
        filters,
      );
    sendSuccess(res, serviceRequests);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /service-requests/:id` carries no Building route parameter, so BE-02
 * Building isolation is enforced here after resolving the record's Building.
 */
export async function getServiceRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseServiceRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const serviceRequest = await serviceRequestService.getServiceRequestById(
      id,
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      serviceRequest.buildingId,
    );

    sendSuccess(res, serviceRequest);
  } catch (error) {
    next(error);
  }
}

export async function updateServiceRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseServiceRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateServiceRequestBody(req.body);

    const existing = await serviceRequestService.getServiceRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const serviceRequest = await serviceRequestService.updateServiceRequest(
      id,
      input,
    );
    sendSuccess(res, serviceRequest);
  } catch (error) {
    next(error);
  }
}

export async function cancelServiceRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseServiceRequestIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await serviceRequestService.getServiceRequestById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const serviceRequest = await serviceRequestService.cancelServiceRequest(id);
    sendSuccess(res, serviceRequest);
  } catch (error) {
    next(error);
  }
}
