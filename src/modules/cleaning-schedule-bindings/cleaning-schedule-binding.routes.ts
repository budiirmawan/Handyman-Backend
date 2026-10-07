import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createCleaningScheduleBindingHandler,
  getCleaningScheduleBindingHandler,
  listAreaCleaningScheduleBindingsHandler,
  updateCleaningScheduleBindingHandler,
} from './cleaning-schedule-binding.controller';

/**
 * BE-11B — Cleaning Schedule Binding endpoints.
 *
 *   POST  /housekeeping/cleaning-areas/:id/schedule-bindings
 *   GET   /housekeeping/cleaning-areas/:id/schedule-bindings
 *   GET   /housekeeping/cleaning-schedule-bindings/:id
 *   PATCH /housekeeping/cleaning-schedule-bindings/:id
 */
export function createCleaningScheduleBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('cleaning_schedule.manage');
  const read = requirePermission('cleaning_schedule.read');

  router.post(
    '/housekeeping/cleaning-areas/:id/schedule-bindings',
    auth,
    manage,
    createCleaningScheduleBindingHandler,
  );
  router.get(
    '/housekeeping/cleaning-areas/:id/schedule-bindings',
    auth,
    read,
    listAreaCleaningScheduleBindingsHandler,
  );
  router.get(
    '/housekeeping/cleaning-schedule-bindings/:id',
    auth,
    read,
    getCleaningScheduleBindingHandler,
  );
  router.patch(
    '/housekeeping/cleaning-schedule-bindings/:id',
    auth,
    manage,
    updateCleaningScheduleBindingHandler,
  );

  return router;
}
