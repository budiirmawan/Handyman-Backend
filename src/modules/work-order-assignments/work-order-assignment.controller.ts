import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { parseAssignmentResponseIdempotencyKey } from '../assignment-responses';
import { workOrderCompetencyService } from '../worker-competency-eligibility';
import { workOrderService } from '../work-orders';
import { workOrderAssignmentService } from './work-order-assignment.service';
import {
  parseAssignWorkOrderBody,
  parseAssignmentIdParam,
  parseCompetencyDecisionFilter,
  parseRespondWorkOrderAssignmentBody,
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
          req.auth.userId,
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
      assignmentId,
    );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-HM-ASSIGNMENT-RESPONSE-01 PART 02A —
 * `POST /work-orders/:id/assignments/:assignmentId/respond`.
 *
 * Records the field assignee's explicit decision (`TERIMA` | `TIDAK_BISA`).
 * The actor identity always comes from the authenticated session, never from
 * the body.
 */
export async function respondToAssignmentHandler(
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

    const body = parseRespondWorkOrderAssignmentBody(req.body);
    // CR-HM-FIELD-OPS-ACK-01 PART 01 — the mobile `Idempotency-Key` header
    // wins over the legacy body member; both are optional and never carry
    // actor/tenant/assignment authority.
    const idempotencyKey = parseAssignmentResponseIdempotencyKey(
      req.header('Idempotency-Key'),
      req.body,
    );
    const assignment =
      await workOrderAssignmentService.respondToWorkOrderAssignment({
        ...body,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        workOrderId,
        assignmentId,
        actorUserId: req.auth.userId,
      });
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}

export async function listAssignmentResponseHistoryHandler(
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

    const history =
      await workOrderAssignmentService.listWorkOrderAssignmentResponseHistory(
        workOrderId,
        assignmentId,
      );
    sendSuccess(res, history);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A —
 * `GET /work-orders/:id/assignments/competency-decisions`.
 *
 * Append-only record of what the competency gate decided for every successful
 * assignment and reassignment of this Work Order: subject × requirement, the
 * verdict, its machine-readable reason and the minimum evidence (opaque
 * certificate id, verification status, expiry, proficiency). Read-only.
 *
 * Authorization is the same rule as every other Work Order assignment route:
 * the Work Order is loaded first (unknown id → 404) and the caller must hold an
 * ACTIVE assignment to its Building (otherwise 403 BUILDING_ACCESS_DENIED).
 * The Client comes from the Work Order row, never from the caller.
 */
export async function listCompetencyDecisionsHandler(
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

    const filter = parseCompetencyDecisionFilter(
      req.query as Record<string, unknown>,
    );
    const paginated = hasPaginationParams(req.query);
    const pg = paginated ? parsePagination(req.query) : null;
    const limit = pg ? pg.pageSize : 100;
    const offset = pg ? (pg.page - 1) * pg.pageSize : 0;

    const { items, total } =
      await workOrderCompetencyService.listWorkOrderAssignmentCompetencyHistory(
        workOrderId,
        filter,
        { limit, offset },
        req.auth.userId,
      );
    sendSuccess(
      res,
      items,
      200,
      pg ? buildPaginationMeta(pg.page, pg.pageSize, total) : {},
    );
  } catch (error) {
    next(error);
  }
}
