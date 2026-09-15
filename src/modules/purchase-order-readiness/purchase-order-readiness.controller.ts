import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { poReadinessService } from './purchase-order-readiness.service';
import {
  parseBuildingIdParam,
  parseCreatePOReadinessBody,
  parsePOReadinessFilters,
  parsePOReadinessIdParam,
  parsePurchaseRequestIdParam,
  parseServiceRequestIdParam,
  parseUpdatePOReadinessBody,
  parseVendorIdParam,
} from './purchase-order-readiness.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createPOReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await poReadinessService.createPOReadiness(
        parseCreatePOReadinessBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getPOReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await poReadinessService.getPOReadiness(
        parsePOReadinessIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePOReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await poReadinessService.updatePOReadiness(
        parsePOReadinessIdParam(param(req.params.id)),
        parseUpdatePOReadinessBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listByPurchaseRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await poReadinessService.listPOReadinessByRequest(
        'PURCHASE_REQUEST',
        parsePurchaseRequestIdParam(param(req.params.purchaseRequestId)),
        parsePOReadinessFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listByServiceRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await poReadinessService.listPOReadinessByRequest(
        'SERVICE_REQUEST',
        parseServiceRequestIdParam(param(req.params.serviceRequestId)),
        parsePOReadinessFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listByVendorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await poReadinessService.listPOReadinessByVendor(
        parseVendorIdParam(param(req.params.vendorId)),
        parsePOReadinessFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listByBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await poReadinessService.listPOReadinessByBuilding(
        parseBuildingIdParam(param(req.params.buildingId)),
        parsePOReadinessFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
