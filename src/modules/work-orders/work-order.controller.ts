import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { workRequestService } from '../work-requests';
import { workOrderService } from './work-order.service';
import {
  parseCompleteWorkOrderBody,
  parseCreateWorkOrderBody,
  parseCreateWorkOrderFromRequestBody,
  parseUpdateWorkOrderBastRequirementBody,
  parseUpdateWorkOrderBody,
  parseUpdateWorkOrderContextBody,
  parseUpdateWorkOrderPriorityBody,
  parseUpdateWorkOrderStatusBody,
  parseWorkOrderBuildingIdParam,
  parseWorkOrderFilters,
  parseWorkOrderIdParam,
  parseWorkRequestIdParam,
} from './work-order.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * `POST /buildings/:buildingId/work-orders`. The creator is derived from the
 * authenticated session — never supplied by the client.
 */
export async function createWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const buildingId = parseWorkOrderBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreateWorkOrderBody(req.body);
    const workOrder = await workOrderService.createWorkOrder({
      ...input,
      buildingId,
      createdByUserId: req.auth.userId,
    });
    sendSuccess(res, workOrder, 201);
  } catch (error) {
    next(error);
  }
}

/**
 * `POST /work-requests/:requestId/work-order` carries no `buildingId` route
 * parameter, so BE-02 Building isolation is enforced here: the Work Request is
 * loaded first (unknown id → 404), then the caller must hold an ACTIVE
 * assignment to its Building (otherwise 403 BUILDING_ACCESS_DENIED). The Work
 * Order then inherits the request's Client/Building.
 */
export async function createWorkOrderFromRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseWorkRequestIdParam(paramString(req.params.requestId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCreateWorkOrderFromRequestBody(req.body);

    const workRequest = await workRequestService.getWorkRequestById(requestId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      workRequest.buildingId,
    );

    const workOrder = await workOrderService.createWorkOrderFromRequest({
      workRequestId: requestId,
      ...input,
      createdByUserId: req.auth.userId,
    });
    sendSuccess(res, workOrder, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingWorkOrdersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseWorkOrderBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const filters = parseWorkOrderFilters(req.query);
    const workOrders = await workOrderService.listWorkOrdersByBuilding(
      buildingId,
      filters,
    );
    sendSuccess(res, workOrders);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /work-orders/team` — CR-BE-MOB-03 PART 04 (TMW-04).
 *
 * Self-service team-scoped Work Order read for supervisors: the team is
 * derived from the authenticated session (linked ACTIVE Workforce Profile's
 * `team_id`), never from a caller-supplied id, and the result is constrained
 * to the caller's BE-02G accessible Buildings. Requires `work_order.read`
 * (existing RBAC). Read-only — no lifecycle change.
 */
export async function listTeamWorkOrdersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filters = parseWorkOrderFilters(req.query);
    const workOrders = await workOrderService.listTeamWorkOrders(
      req.auth.userId,
      filters,
    );
    sendSuccess(res, workOrders);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /work-orders/:id` and `PATCH /work-orders/:id` carry no `buildingId`
 * route parameter, so BE-02 Building isolation is enforced here instead of via
 * `requireBuildingAccess`: the order is loaded first (unknown id → 404), then
 * the caller must hold an ACTIVE assignment to its Building (otherwise 403
 * BUILDING_ACCESS_DENIED). Permission alone is never enough.
 */
export async function getWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const workOrder = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      workOrder.buildingId,
    );

    sendSuccess(res, workOrder);
  } catch (error) {
    next(error);
  }
}

export async function updateWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateWorkOrderBody(req.body);

    const existing = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const workOrder = await workOrderService.updateWorkOrder(id, input);
    sendSuccess(res, workOrder);
  } catch (error) {
    next(error);
  }
}

export async function updateWorkOrderPriorityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateWorkOrderPriorityBody(req.body);

    const existing = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const workOrder = await workOrderService.updateWorkOrderPriority(id, input);
    sendSuccess(res, workOrder);
  } catch (error) {
    next(error);
  }
}

export async function updateWorkOrderBastRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const input = parseUpdateWorkOrderBastRequirementBody(req.body);
    const existing = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );
    const workOrder = await workOrderService.updateWorkOrderBastRequirement(
      id,
      input,
      req.auth.userId,
    );
    sendSuccess(res, workOrder);
  } catch (error) {
    next(error);
  }
}

export async function updateWorkOrderStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateWorkOrderStatusBody(req.body);

    const existing = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const workOrder = await workOrderService.transitionWorkOrderStatus(id, input);
    sendSuccess(res, workOrder);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /work-orders/:id/complete — validates readiness (state, assignment,
 * authorization, required evidence) and transitions to COMPLETED.
 */
export async function completeWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseCompleteWorkOrderBody(req.body);

    const existing = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const workOrder = await workOrderService.completeWorkOrder({
      workOrderId: id,
      ...input,
      actorUserId: req.auth.userId,
    });
    sendSuccess(res, workOrder);
  } catch (error) {
    next(error);
  }
}

/** GET /work-orders/:id/completion — returns the completion subset. */
export async function getWorkOrderCompletionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const completion = await workOrderService.getWorkOrderCompletion(id);
    sendSuccess(res, completion);
  } catch (error) {
    next(error);
  }
}

/**
 * `PATCH /work-orders/:id/context` binds (or clears) the Asset / Functional
 * Location on a Work Order, enforcing BE-02 Building isolation in the
 * controller after resolving the record's Building.
 */
export async function updateWorkOrderContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateWorkOrderContextBody(req.body);

    const existing = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const workOrder = await workOrderService.bindWorkOrderContext(id, input);
    sendSuccess(res, workOrder);
  } catch (error) {
    next(error);
  }
}

/** `GET /work-orders/:id/context` returns the resolved Asset / Location context. */
export async function getWorkOrderContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseWorkOrderIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await workOrderService.getWorkOrderById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const context = await workOrderService.getWorkOrderContext(id);
    sendSuccess(res, context);
  } catch (error) {
    next(error);
  }
}
