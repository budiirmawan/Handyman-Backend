import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  closeWorkOrderHandler,
  getVerificationHandler,
  submitVerificationHandler,
} from './work-order-verification.controller';

/**
 * BE-08I — Work Order Verification / Rework / Closure endpoints, protected by
 * BE-01 RBAC and BE-02 Building isolation (enforced in the controller after
 * resolving the Work Order's Building). Reuses the BE-07 review primitive.
 *
 * Reads (`work_order.read`):
 *   GET  /work-orders/:id/verification
 * Management (`work_order.manage`):
 *   POST /work-orders/:id/verification
 *   POST /work-orders/:id/close
 *
 * No separate finding/verification engine is used.
 */
export function createWorkOrderVerificationRouter(): Router {
  const router = Router();

  router.get(
    '/work-orders/:id/verification',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    getVerificationHandler,
  );
  router.post(
    '/work-orders/:id/verification',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    submitVerificationHandler,
  );
  router.post(
    '/work-orders/:id/close',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    closeWorkOrderHandler,
  );

  return router;
}
