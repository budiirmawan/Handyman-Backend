import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  completePatrolExecutionHandler,
  getPatrolExecutionHandler,
  getPatrolFieldContextHandler,
  listBuildingPatrolExecutionsHandler,
  listPatrolPointVisitsHandler,
  startPatrolExecutionHandler,
  updatePatrolPointVisitHandler,
  visitPatrolPointHandler,
} from './patrol-execution.controller';

/**
 * BE-12D — Patrol Execution endpoints.
 *
 *   GET   /buildings/:buildingId/security/patrol-executions
 *   GET   /security/patrol-executions/:id
 *   GET   /security/patrol-executions/:id/field-context
 *   POST  /security/patrol-executions/:id/start
 *   POST  /security/patrol-executions/:id/points/:pointId/visit
 *   GET   /security/patrol-executions/:id/points
 *   POST  /security/patrol-executions/:id/complete
 *   PATCH /security/patrol-point-visits/:id
 *
 * Patrol Execution is the Security operational view of an authoritative
 * BE-07 generated_task bound to a BE-12B Patrol Route via a BE-12C
 * Patrol Schedule Binding. The shared task lifecycle and status remain
 * authoritative in BE-07; this module delegates start/complete by
 * updating `generated_tasks.status` (the shared `task-execution` engine
 * owns the transitions). Patrol Point progress is the only new
 * operational state, persisted in `patrol_point_visits`.
 */
export function createPatrolExecutionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('patrol_execution.manage');
  const read = requirePermission('patrol_execution.read');

  router.get(
    '/buildings/:buildingId/security/patrol-executions',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingPatrolExecutionsHandler,
  );
  router.get(
    '/security/patrol-executions/:id',
    auth,
    read,
    getPatrolExecutionHandler,
  );
  // CR-BE-RN16-PATROL-FIELD-01 PART 01 — mobile field entry: the execution,
  // its canonical route points with visits, and the backend-derived field
  // actions. Read-only; the existing start/visit/complete commands below stay
  // the only mutation path.
  router.get(
    '/security/patrol-executions/:id/field-context',
    auth,
    read,
    getPatrolFieldContextHandler,
  );
  router.post(
    '/security/patrol-executions/:id/start',
    auth,
    manage,
    startPatrolExecutionHandler,
  );
  router.post(
    '/security/patrol-executions/:id/points/:pointId/visit',
    auth,
    manage,
    visitPatrolPointHandler,
  );
  router.get(
    '/security/patrol-executions/:id/points',
    auth,
    read,
    listPatrolPointVisitsHandler,
  );
  router.post(
    '/security/patrol-executions/:id/complete',
    auth,
    manage,
    completePatrolExecutionHandler,
  );
  router.patch(
    '/security/patrol-point-visits/:id',
    auth,
    manage,
    updatePatrolPointVisitHandler,
  );

  return router;
}
