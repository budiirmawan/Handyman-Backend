import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { workOrderService } from '../work-orders';
import { workOrderActionService } from './work-order-action.service';
import {
  parseNotesBody,
  parseWorkOrderIdParam,
} from './work-order-action.validation';
import type { WorkOrderActionType } from './work-order-action.types';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** Enforces BE-02 Building isolation: load the Work Order, then check access. */
async function assertWorkOrderBuildingAccess(
  userId: string,
  workOrderId: string,
): Promise<void> {
  const workOrder = await workOrderService.getWorkOrderById(workOrderId);
  await contextAccessService.assertBuildingAccess(userId, workOrder.buildingId);
}

async function runAction(
  req: Request,
  res: Response,
  next: NextFunction,
  actionType: WorkOrderActionType,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const { notes } = parseNotesBody(req.body);
    const action = await workOrderActionService.recordWorkOrderAction({
      workOrderId,
      actionType,
      actorUserId: req.auth.userId,
      notes,
    });
    sendSuccess(res, action, 201);
  } catch (error) {
    next(error);
  }
}

export function acknowledgeWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runAction(req, res, next, 'ACKNOWLEDGED');
}

export function startWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runAction(req, res, next, 'STARTED');
}

export function holdWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runAction(req, res, next, 'ON_HOLD');
}

export function resumeWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runAction(req, res, next, 'RESUMED');
}

export function addNoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runAction(req, res, next, 'NOTE_ADDED');
}

export function cancelWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runAction(req, res, next, 'CANCELLED');
}

export async function listActionsHandler(
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

    const actions = await workOrderActionService.listWorkOrderActions(
      workOrderId,
    );
    sendSuccess(res, actions);
  } catch (error) {
    next(error);
  }
}
