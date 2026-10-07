import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  completeWorkOrderHandler,
  createWorkOrderFromRequestHandler,
  createWorkOrderHandler,
  getWorkOrderCompletionHandler,
  getWorkOrderContextHandler,
  getWorkOrderHandler,
  listBuildingWorkOrdersHandler,
  listTeamWorkOrdersHandler,
  updateWorkOrderBastRequirementHandler,
  updateWorkOrderContextHandler,
  updateWorkOrderHandler,
  updateWorkOrderPriorityHandler,
  updateWorkOrderStatusHandler,
} from './work-order.controller';

/**
 * BE-08B — Work Order endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation.
 *
 * Reads (`work_order.read`):
 *   GET  /buildings/:buildingId/work-orders   (?status= & ?workType= & ?workRequestId=)
 *   GET  /work-orders/:id
 * Management (`work_order.manage`):
 *   POST /buildings/:buildingId/work-orders
 *   POST /work-requests/:requestId/work-order
 *   PATCH /work-orders/:id
 *   PATCH /work-orders/:id/priority   (BE-08C)
 *   PATCH /work-orders/:id/status     (BE-08C lifecycle transition)
 *   POST  /work-orders/:id/complete   (BE-08H)
 *   GET   /work-orders/:id/completion (BE-08H)
 *
 * Building-nested routes pass through `requireBuildingAccess('buildingId')`.
 * The conversion route and the `/work-orders/:id` routes carry no building
 * param, so the controller enforces the same rule after resolving the
 * record's Building — Work Order administration inherits BE-02 isolation
 * rather than opening a side channel around it.
 *
 * No assignment or execution endpoints are exposed here (later BE-08 PARTs).
 */
export function createWorkOrderRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/work-orders',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    requireBuildingAccess('buildingId'),
    createWorkOrderHandler,
  );
  router.post(
    '/work-requests/:requestId/work-order',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    createWorkOrderFromRequestHandler,
  );
  router.get(
    '/buildings/:buildingId/work-orders',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    requireBuildingAccess('buildingId'),
    listBuildingWorkOrdersHandler,
  );
  // CR-BE-MOB-03 PART 04 — team-scoped Work Order read (TMW-04). Registered
  // BEFORE `/work-orders/:id` so the literal `team` segment is never
  // captured as an id. Self-service: the team is derived from the
  // authenticated session; the result is constrained to the caller's
  // BE-02G accessible Buildings.
  router.get(
    '/work-orders/team',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    listTeamWorkOrdersHandler,
  );
  router.get(
    '/work-orders/:id',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    getWorkOrderHandler,
  );
  router.patch(
    '/work-orders/:id',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    updateWorkOrderHandler,
  );
  router.patch(
    '/work-orders/:id/priority',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    updateWorkOrderPriorityHandler,
  );
  router.patch(
    '/work-orders/:id/bast-requirement',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    updateWorkOrderBastRequirementHandler,
  );
  router.patch(
    '/work-orders/:id/status',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    updateWorkOrderStatusHandler,
  );
  router.patch(
    '/work-orders/:id/context',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    updateWorkOrderContextHandler,
  );
  router.get(
    '/work-orders/:id/context',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    getWorkOrderContextHandler,
  );
  router.post(
    '/work-orders/:id/complete',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    completeWorkOrderHandler,
  );
  router.get(
    '/work-orders/:id/completion',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    getWorkOrderCompletionHandler,
  );

  return router;
}
