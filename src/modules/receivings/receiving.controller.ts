import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { receivingService } from './receiving.service';
import {
  parseBuildingIdParam,
  parseCreateReceivingBody,
  parsePurchaseRequestIdParam,
  parseReceivingFilters,
  parseReceivingIdParam,
  parseServiceRequestIdParam,
  parseUpdateReceivingBody,
  parseVendorIdParam,
} from './receiving.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createReceivingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await receivingService.createReceiving(
        parseCreateReceivingBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getReceivingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await receivingService.getReceiving(
        parseReceivingIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateReceivingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await receivingService.updateReceiving(
        parseReceivingIdParam(param(req.params.id)),
        parseUpdateReceivingBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function finalizeReceivingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await receivingService.finalizeReceiving(
        parseReceivingIdParam(param(req.params.id)),
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
      await receivingService.listReceivingsByRequest(
        'PURCHASE_REQUEST',
        parsePurchaseRequestIdParam(param(req.params.purchaseRequestId)),
        parseReceivingFilters(req.query),
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
      await receivingService.listReceivingsByRequest(
        'SERVICE_REQUEST',
        parseServiceRequestIdParam(param(req.params.serviceRequestId)),
        parseReceivingFilters(req.query),
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
      await receivingService.listReceivingsByVendor(
        parseVendorIdParam(param(req.params.vendorId)),
        parseReceivingFilters(req.query),
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
      await receivingService.listReceivingsByBuilding(
        parseBuildingIdParam(param(req.params.buildingId)),
        parseReceivingFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
