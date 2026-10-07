import { Router, type NextFunction, type Request, type Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { contextAccessService } from '../context-access';
import { workOrderService } from '../work-orders';
import { parseWorkOrderIdParam } from '../work-orders/work-order.validation';
import { listWorkOrderEscalations } from './sla-escalation-action.read';

/**
 * CR-BE-SLA-02 PART 05 — Work Order escalation history (read-only).
 *
 * `GET /work-orders/{id}/sla/escalations`
 *
 * ACCESS AUTHORITY (identical to `GET /work-orders/{id}/sla`)
 * ----------------------------------------------------------
 * 1. `work_order.read` — §10.1: escalation history is Work Order data, so it
 *    reuses the Work Order permission rather than inventing an SLA-specific one.
 * 2. The Work Order must exist and be readable — `getWorkOrderById` 404s first,
 *    so an unknown id never reaches the ledger.
 * 3. `assertBuildingAccess(caller, workOrder.buildingId)` — Building isolation
 *    is derived from the **Work Order**, never from a caller-supplied
 *    Client/Building. A caller without an ACTIVE assignment to that Building is
 *    rejected before any escalation row is read, so the endpoint cannot be used
 *    to probe another Client's escalation activity.
 *
 * NO EXECUTION SURFACE
 * --------------------
 * This router is GET-only. There is deliberately no manual trigger, retry,
 * cancel, or re-send endpoint: escalation execution belongs exclusively to the
 * PART 04 dispatcher, and exposing an HTTP path into it would break the
 * claim-before-send guarantee that makes delivery at-most-once.
 */

const first = (value: string | string[]): string => (Array.isArray(value) ? value[0] ?? '' : value);

async function listEscalations(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(first(request.params.id));
    const workOrder = await workOrderService.getWorkOrderById(workOrderId);
    await contextAccessService.assertBuildingAccess(request.auth.userId, workOrder.buildingId);
    sendSuccess(response, await listWorkOrderEscalations(workOrderId));
  } catch (error) {
    next(error);
  }
}

export function createSlaEscalationActionRouter(): Router {
  const router = Router();
  router.get(
    '/work-orders/:id/sla/escalations',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    listEscalations,
  );
  return router;
}
