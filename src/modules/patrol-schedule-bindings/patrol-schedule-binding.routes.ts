import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createPatrolScheduleBindingHandler,
  getPatrolScheduleBindingHandler,
  listRoutePatrolScheduleBindingsHandler,
  updatePatrolScheduleBindingHandler,
} from './patrol-schedule-binding.controller';

/**
 * BE-12C — Patrol Schedule Binding endpoints.
 *
 *   POST  /security/patrol-routes/:id/schedule-bindings
 *   GET   /security/patrol-routes/:id/schedule-bindings
 *   GET   /security/patrol-schedule-bindings/:id
 *   PATCH /security/patrol-schedule-bindings/:id
 *
 * The binding associates a BE-12B Patrol Route with a shared BE-07
 * Schedule Definition. Recurrence, occurrence preview, and task
 * generation are delegated to BE-07 — this module never re-implements
 * them.
 */
export function createPatrolScheduleBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('patrol_schedule.manage');
  const read = requirePermission('patrol_schedule.read');

  router.post(
    '/security/patrol-routes/:id/schedule-bindings',
    auth,
    manage,
    createPatrolScheduleBindingHandler,
  );
  router.get(
    '/security/patrol-routes/:id/schedule-bindings',
    auth,
    read,
    listRoutePatrolScheduleBindingsHandler,
  );
  router.get(
    '/security/patrol-schedule-bindings/:id',
    auth,
    read,
    getPatrolScheduleBindingHandler,
  );
  router.patch(
    '/security/patrol-schedule-bindings/:id',
    auth,
    manage,
    updatePatrolScheduleBindingHandler,
  );

  return router;
}
