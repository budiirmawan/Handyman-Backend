import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { workOrderTradeCategoryService } from './work-order-trade-category.service';
import {
  parseTradeCategoryIdParam,
  parseWorkOrderIdParam,
  validateClassificationInput,
  validateCreateTradeCategoryInput,
  validateListTradeCategoriesFilter,
  validateUpdateTradeCategoryInput,
} from './work-order-trade-category.validation';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — trade registry + Work Order
 * classification handlers.
 *
 * The transport validates the payload, takes the actor from the authenticated
 * session, and delegates. It never accepts a Client or Building from the
 * caller: the Work Order row is the authority for both, and the service
 * re-checks the caller's Building assignment.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function listTradeCategoriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filter = validateListTradeCategoriesFilter(
      req.query as Record<string, unknown>,
    );
    sendSuccess(
      res,
      await workOrderTradeCategoryService.listWorkOrderTradeCategories(filter),
    );
  } catch (error) {
    next(error);
  }
}

export async function getTradeCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseTradeCategoryIdParam(param(req.params.tradeCategoryId));
    sendSuccess(
      res,
      await workOrderTradeCategoryService.getWorkOrderTradeCategoryById(id),
    );
  } catch (error) {
    next(error);
  }
}

export async function createTradeCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = validateCreateTradeCategoryInput(req.body, actor(req));
    sendSuccess(
      res,
      await workOrderTradeCategoryService.createWorkOrderTradeCategory(
        input,
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function updateTradeCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseTradeCategoryIdParam(param(req.params.tradeCategoryId));
    const changes = validateUpdateTradeCategoryInput(req.body);
    sendSuccess(
      res,
      await workOrderTradeCategoryService.updateWorkOrderTradeCategory(
        id,
        changes,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deactivateTradeCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseTradeCategoryIdParam(param(req.params.tradeCategoryId));
    sendSuccess(
      res,
      await workOrderTradeCategoryService.deactivateWorkOrderTradeCategory(
        id,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getWorkOrderClassificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(param(req.params.id));
    sendSuccess(
      res,
      await workOrderTradeCategoryService.getWorkOrderClassification(
        workOrderId,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function classifyWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(param(req.params.id));
    const input = validateClassificationInput(req.body);
    sendSuccess(
      res,
      await workOrderTradeCategoryService.classifyWorkOrder(
        workOrderId,
        input,
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
