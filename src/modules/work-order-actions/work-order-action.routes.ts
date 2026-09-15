import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  acknowledgeWorkOrderHandler,
  addNoteHandler,
  cancelWorkOrderHandler,
  holdWorkOrderHandler,
  listActionsHandler,
  resumeWorkOrderHandler,
  startWorkOrderHandler,
} from './work-order-action.controller';

/**
 * BE-08F — Work Order Execution Action endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the controller after resolving the
 * Work Order's Building). Lifecycle validity reuses BE-08C; assignment
 * authorization reuses the BE-08E active assignment.
 *
 * Management (`work_order.manage`):
 *   POST /work-orders/:id/acknowledge
 *   POST /work-orders/:id/start
 *   POST /work-orders/:id/hold
 *   POST /work-orders/:id/resume
 *   POST /work-orders/:id/notes
 *   POST /work-orders/:id/cancel
 * Reads (`work_order.read`):
 *   GET  /work-orders/:id/actions
 *
 * No completion / evidence / verification endpoints are exposed here.
 */
export function createWorkOrderActionRouter(): Router {
  const router = Router();

  router.post(
    '/work-orders/:id/acknowledge',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    acknowledgeWorkOrderHandler,
  );
  router.post(
    '/work-orders/:id/start',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    startWorkOrderHandler,
  );
  router.post(
    '/work-orders/:id/hold',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    holdWorkOrderHandler,
  );
  router.post(
    '/work-orders/:id/resume',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    resumeWorkOrderHandler,
  );
  router.post(
    '/work-orders/:id/notes',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    addNoteHandler,
  );
  router.post(
    '/work-orders/:id/cancel',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    cancelWorkOrderHandler,
  );
  router.get(
    '/work-orders/:id/actions',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    listActionsHandler,
  );

  return router;
}
