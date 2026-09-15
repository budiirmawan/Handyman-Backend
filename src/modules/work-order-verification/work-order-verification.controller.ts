import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { workOrderService } from '../work-orders';
import { workOrderVerificationService } from './work-order-verification.service';
import {
  parseVerificationBody,
  parseWorkOrderIdParam,
} from './work-order-verification.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

async function assertWorkOrderBuildingAccess(
  userId: string,
  workOrderId: string,
): Promise<void> {
  const workOrder = await workOrderService.getWorkOrderById(workOrderId);
  await contextAccessService.assertBuildingAccess(userId, workOrder.buildingId);
}

export async function getVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const state = await workOrderVerificationService.getWorkOrderVerificationState(
      workOrderId,
    );
    sendSuccess(res, state);
  } catch (error) {
    next(error);
  }
}

export async function submitVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const input = parseVerificationBody(req.body);
    const result = await workOrderVerificationService.submitWorkOrderVerification({
      ...input,
      workOrderId,
      reviewerUserId: req.auth.userId,
    });
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function closeWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const result = await workOrderVerificationService.closeWorkOrder(workOrderId);
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
