import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { purchaseOrderPriceDeviationService } from './purchase-order-price-deviation.service';
import { purchaseOrderService } from './purchase-order.service';
import {
  parseCreatePurchaseOrderBody,
  parseIssuePurchaseOrderBody,
  parsePurchaseOrderFilters,
  parsePurchaseOrderIdParam,
  parseUpdatePurchaseOrderBody,
} from './purchase-order.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createPurchaseOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderService.createPurchaseOrder(
        parseCreatePurchaseOrderBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getPurchaseOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderService.getPurchaseOrder(
        parsePurchaseOrderIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPurchaseOrdersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderService.listPurchaseOrders(
        parsePurchaseOrderFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePurchaseOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderService.updatePurchaseOrder(
        parsePurchaseOrderIdParam(param(req.params.id)),
        parseUpdatePurchaseOrderBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelPurchaseOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderService.cancelPurchaseOrder(
        parsePurchaseOrderIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ─── PART 03: Issuance ──────────────────────────────────────────

export async function issuePurchaseOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderService.issuePurchaseOrder(
        parsePurchaseOrderIdParam(param(req.params.id)),
        parseIssuePurchaseOrderBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getPurchaseOrderAvailableActionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderService.resolvePurchaseOrderAvailableActions(
        parsePurchaseOrderIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getPurchaseOrderIssueReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderService.getPurchaseOrderIssueReadiness(
        parsePurchaseOrderIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/**
 * CR-BE-PRICE-01 PART 06 — advisory price-deviation projection (§13.3).
 * Pure read: computes PO line prices against the current reference-price
 * authority; never gates issuance, never mutates PO facts.
 */
export async function getPurchaseOrderPriceDeviationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await purchaseOrderPriceDeviationService.getPurchaseOrderPriceDeviation(
        parsePurchaseOrderIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
