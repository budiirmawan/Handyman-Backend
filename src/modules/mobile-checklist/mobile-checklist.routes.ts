import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getMobileChecklistExecutionHandler } from './mobile-checklist.controller';

/**
 * BE-25D — Mobile Checklist Contract.
 *
 *   GET /mobile/checklist-executions/:executionId
 *
 * Mobile read-model of a checklist execution: checklist/task reference,
 * items with values/status, measurement/UOM, evidence requirements, execution
 * status, and backend-authoritative available actions. Composition over the
 * BE-07 authorities only — no separate mobile checklist engine. Evidence
 * submission itself is BE-25E.
 */
export function createMobileChecklistRouter(): Router {
  const router = Router();

  router.get(
    '/mobile/checklist-executions/:executionId',
    authenticationMiddleware,
    requirePermission('checklist.read'),
    getMobileChecklistExecutionHandler,
  );

  return router;
}
