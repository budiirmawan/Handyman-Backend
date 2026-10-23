import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignWorkOrderHandler,
  getCurrentAssignmentHandler,
  listAssignmentResponseHistoryHandler,
  listAssignmentsHandler,
  listCompetencyDecisionsHandler,
  respondToAssignmentHandler,
  updateAssignmentHandler,
} from './work-order-assignment.controller';

/**
 * BE-08E + CR-HM-ASSIGNMENT-RESPONSE-01 PART 02A +
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — Work Order Assignment, Assignment
 * Response and competency decision history endpoints, protected by BE-01 RBAC
 * and BE-02 Building isolation (enforced in the controller after resolving the
 * Work Order's Building).
 *
 * Management (`work_order.manage`):
 *   POST  /work-orders/:id/assignments
 *   PATCH /work-orders/:id/assignments/:assignmentId   (deactivate or reassign)
 * Field Assignee Response (`work_order.read` + Building scope + assignment ownership):
 *   POST  /work-orders/:id/assignments/:assignmentId/respond
 * Reads (`work_order.read`):
 *   GET   /work-orders/:id/assignments
 *   GET   /work-orders/:id/assignments/current
 *   GET   /work-orders/:id/assignments/competency-decisions
 *   GET   /work-orders/:id/assignments/:assignmentId/response-history
 *
 * Every route is registered exactly once. Static segments are declared before
 * the `:assignmentId` routes so a static name can never be captured as an id.
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
  // history (append-only ledger). Registered BEFORE the `:assignmentId` routes
  // and on a static segment, so it can never be captured as an id.
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
  router.post(
    '/work-orders/:id/assignments/:assignmentId/respond',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    respondToAssignmentHandler,
  );
  router.get(
    '/work-orders/:id/assignments/:assignmentId/response-history',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    listAssignmentResponseHistoryHandler,
  );

  return router;
}
