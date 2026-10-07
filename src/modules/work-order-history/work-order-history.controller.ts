import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { workOrderService } from '../work-orders';
import { workOrderHistoryService } from './work-order-history.service';
import {
  parseHistoryFilters,
  parseWorkOrderIdParam,
} from './work-order-history.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * GET /work-orders/:id/history — enforces BE-02 Building isolation by loading
 * the Work Order first, then asserting access to its Building. History is
 * read-only; no arbitrary event-creation endpoint is exposed.
 */
export async function getWorkOrderHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const workOrder = await workOrderService.getWorkOrderById(workOrderId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      workOrder.buildingId,
    );

    const filters = parseHistoryFilters(req.query);
    const history = await workOrderHistoryService.getWorkOrderHistory(
      workOrderId,
      filters,
    );
    sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
}
