import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { listMobileAssignmentsHandler } from './mobile-assignment.controller';

/**
 * BE-25C — Mobile Assignment Contract.
 *
 *   GET /mobile/assignments    (?page=&pageSize=)
 *
 * Unified "my assignments" feed for mobile field users: the authenticated
 * user's active Task (BE-07) and Work Order (BE-08) assignments within the
 * accessible Client/Building scope (BE-02G), with backend-authoritative
 * `availableActions`. Read-model composition only — no separate assignment
 * engine.
 */
export function createMobileAssignmentRouter(): Router {
  const router = Router();

  router.get(
    '/mobile/assignments',
    authenticationMiddleware,
    requirePermission('task.read'),
    requirePermission('work_order.read'),
    listMobileAssignmentsHandler,
  );

  return router;
}
