import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getWorkOrderHistoryHandler } from './work-order-history.controller';

/**
 * BE-08J — Work Order History endpoint, protected by BE-01 RBAC and BE-02
 * Building isolation (enforced in the controller after resolving the Work
 * Order's Building). Reuses the BE-07 operational event binding.
 *
 * Reads (`work_order.read`):
 *   GET /work-orders/:id/history  (?eventType= & ?from= & ?to=)
 *
 * History is read-only — no event-creation endpoint is exposed.
 */
export function createWorkOrderHistoryRouter(): Router {
  const router = Router();

  router.get(
    '/work-orders/:id/history',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    getWorkOrderHistoryHandler,
  );

  return router;
}
