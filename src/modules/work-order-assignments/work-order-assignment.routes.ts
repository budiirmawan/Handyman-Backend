import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignWorkOrderHandler,
  getCurrentAssignmentHandler,
  listAssignmentsHandler,
  listCompetencyDecisionsHandler,
  updateAssignmentHandler,
} from './work-order-assignment.controller';

/**
 * BE-08E — Work Order Assignment endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation (enforced in the controller after resolving the Work
 * Order's Building).
 *
 * Management (`work_order.manage`):
 *   POST  /work-orders/:id/assignments
 *   PATCH /work-orders/:id/assignments/:assignmentId   (deactivate or reassign)
 * Reads (`work_order.read`):
 *   GET   /work-orders/:id/assignments
 *   GET   /work-orders/:id/assignments/current
 *
 * No execution/evidence endpoints are exposed here (later BE-08 PARTs).
 */
export function createWorkOrderAssignmentRouter(): Router {
  const router = Router();

  router.post(
    '/work-orders/:id/assignments',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    assignWorkOrderHandler,
  );
  router.get(
    '/work-orders/:id/assignments',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    listAssignmentsHandler,
  );
  router.get(
    '/work-orders/:id/assignments/current',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    getCurrentAssignmentHandler,
  );
  // CR-HM-WORKER-COMPETENCY-01 PART 03B2A — read-only competency decision
  // history (append-only ledger). Registered BEFORE the `:assignmentId` PATCH
  // route and on a static segment, so it can never be captured as an id.
  router.get(
    '/work-orders/:id/assignments/competency-decisions',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    listCompetencyDecisionsHandler,
  );
  router.patch(
    '/work-orders/:id/assignments/:assignmentId',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    updateAssignmentHandler,
  );

  return router;
}
