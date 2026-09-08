import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { workOrderService } from '../work-orders';
import { vendorAssignmentService } from './vendor-assignment.service';
import {
  parseAssignVendorAssignmentBody,
  parseUpdateVendorAssignmentBody,
  parseVendorAssignmentFilters,
  parseVendorAssignmentIdParam,
} from './vendor-assignment.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * BE-02 Building isolation for routes that carry no Building param: the Work
 * Order is resolved first (unknown id → 404), then the caller must hold an
 * ACTIVE assignment to its Building (otherwise 403 BUILDING_ACCESS_DENIED).
 */
async function assertWorkOrderBuildingAccess(
  userId: string,
  workOrderId: string,
): Promise<void> {
  const workOrder = await workOrderService.getWorkOrderById(workOrderId);
  await contextAccessService.assertBuildingAccess(userId, workOrder.buildingId);
}

export async function assignVendorHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const input = parseAssignVendorAssignmentBody(req.body);
    await assertWorkOrderBuildingAccess(req.auth.userId, input.workOrderId);

    const assignment = await vendorAssignmentService.assignVendor({
      ...input,
      assignedByUserId: req.auth.userId,
    });
    sendSuccess(res, assignment, 201);
  } catch (error) {
    next(error);
  }
}

export async function getVendorAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assignmentId = parseVendorAssignmentIdParam(
      paramString(req.params.assignmentId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const assignment =
      await vendorAssignmentService.getVendorAssignment(assignmentId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      assignment.buildingId,
    );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}

export async function listVendorAssignmentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseVendorAssignmentFilters(req.query as Record<string, unknown>);

    if (filters.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filters.buildingId,
      );
    }
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(req.auth.userId);

    const assignments = await vendorAssignmentService.listVendorAssignments(
      filters,
      accessibleBuildingIds,
    );
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /vendor-assignments/:assignmentId — deactivates the target
 * assignment (`{ status: 'INACTIVE' }`) or reassigns it (a vendor/work-order
 * payload), which deactivates the current assignment and creates a new one.
 */
export async function updateVendorAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assignmentId = parseVendorAssignmentIdParam(
      paramString(req.params.assignmentId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const current =
      await vendorAssignmentService.getVendorAssignment(assignmentId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      current.buildingId,
    );

    const body = parseUpdateVendorAssignmentBody(req.body);

    if ('deactivate' in body) {
      const assignment =
        await vendorAssignmentService.deactivateVendorAssignment(assignmentId);
      sendSuccess(res, assignment);
      return;
    }

    await assertWorkOrderBuildingAccess(req.auth.userId, body.reassign.workOrderId);
    const assignment = await vendorAssignmentService.reassignVendorAssignment(
      assignmentId,
      {
        ...body.reassign,
        assignedByUserId: req.auth.userId,
      },
    );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}
