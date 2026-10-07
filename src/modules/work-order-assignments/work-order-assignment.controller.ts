import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { workOrderService } from '../work-orders';
import { workOrderAssignmentService } from './work-order-assignment.service';
import {
  parseAssignWorkOrderBody,
  parseAssignmentIdParam,
  parseUpdateAssignmentBody,
  parseWorkOrderIdParam,
} from './work-order-assignment.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * Every assignment route carries no Building param, so BE-02 Building
 * isolation is enforced here: the Work Order is loaded first (unknown id →
 * 404), then the caller must hold an ACTIVE assignment to its Building
 * (otherwise 403 BUILDING_ACCESS_DENIED).
 */
async function assertWorkOrderBuildingAccess(
  userId: string,
  workOrderId: string,
): Promise<void> {
  const workOrder = await workOrderService.getWorkOrderById(workOrderId);
  await contextAccessService.assertBuildingAccess(userId, workOrder.buildingId);
}

export async function assignWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseAssignWorkOrderBody(req.body);
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const assignment = await workOrderAssignmentService.assignWorkOrder({
      ...input,
      workOrderId,
      assignedByUserId: req.auth.userId,
    });
    sendSuccess(res, assignment, 201);
  } catch (error) {
    next(error);
  }
}

export async function getCurrentAssignmentHandler(
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

    const assignment =
      await workOrderAssignmentService.getCurrentWorkOrderAssignment(workOrderId);
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}

export async function listAssignmentsHandler(
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

    const assignments =
      await workOrderAssignmentService.listWorkOrderAssignments(workOrderId);
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /work-orders/:id/assignments/:assignmentId — deactivates the target
 * assignment (`{ status: 'INACTIVE' }`) or reassigns the Work Order (an
 * assignee payload), which deactivates the current active assignment and
 * creates a new one.
 */
export async function updateAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.id));
    const assignmentId = parseAssignmentIdParam(
      paramString(req.params.assignmentId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    await assertWorkOrderBuildingAccess(req.auth.userId, workOrderId);

    const body = parseUpdateAssignmentBody(req.body);

    if ('deactivate' in body) {
      const assignment =
        await workOrderAssignmentService.deactivateWorkOrderAssignment(
          workOrderId,
          assignmentId,
        );
      sendSuccess(res, assignment);
      return;
    }

    const assignment = await workOrderAssignmentService.reassignWorkOrder(
      workOrderId,
      {
        ...body.reassign,
        workOrderId,
        assignedByUserId: req.auth.userId,
      },
    );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}
