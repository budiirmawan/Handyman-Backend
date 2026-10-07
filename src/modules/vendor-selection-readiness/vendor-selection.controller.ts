import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { vendorSelectionService } from './vendor-selection.service';
import {
  parseCreateVendorSelectionBody,
  parsePurchaseRequestIdParam,
  parseServiceRequestIdParam,
  parseVendorIdParam,
  parseVendorSelectionFilters,
  parseVendorSelectionIdParam,
} from './vendor-selection.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createVendorSelectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorSelectionService.createVendorSelection(
        parseCreateVendorSelectionBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getVendorSelectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await vendorSelectionService.getVendorSelection(
        parseVendorSelectionIdParam(param(req.params.id)),
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
      await vendorSelectionService.listVendorSelectionsByRequest(
        'PURCHASE_REQUEST',
        parsePurchaseRequestIdParam(param(req.params.purchaseRequestId)),
        parseVendorSelectionFilters(req.query),
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
      await vendorSelectionService.listVendorSelectionsByRequest(
        'SERVICE_REQUEST',
        parseServiceRequestIdParam(param(req.params.serviceRequestId)),
        parseVendorSelectionFilters(req.query),
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
      await vendorSelectionService.listVendorSelectionsByVendor(
        parseVendorIdParam(param(req.params.vendorId)),
        parseVendorSelectionFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
