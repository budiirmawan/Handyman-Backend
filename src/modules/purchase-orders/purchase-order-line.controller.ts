import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { purchaseOrderLineService } from './purchase-order-line.service';
import {
  parseAddPurchaseOrderLineBody,
  parsePurchaseOrderLineIdParam,
  parseUpdatePurchaseOrderLineBody,
} from './purchase-order-line.validation';
import { parsePurchaseOrderIdParam } from './purchase-order.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function addPurchaseOrderLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderLineService.addPurchaseOrderLine(
        parsePurchaseOrderIdParam(param(req.params.id)),
        parseAddPurchaseOrderLineBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listPurchaseOrderLinesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderLineService.listPurchaseOrderLines(
        parsePurchaseOrderIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getPurchaseOrderLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderLineService.getPurchaseOrderLine(
        parsePurchaseOrderLineIdParam(param(req.params.lineId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePurchaseOrderLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderLineService.updatePurchaseOrderLine(
        parsePurchaseOrderLineIdParam(param(req.params.lineId)),
        parseUpdatePurchaseOrderLineBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function removePurchaseOrderLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderLineService.removePurchaseOrderLine(
        parsePurchaseOrderLineIdParam(param(req.params.lineId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
