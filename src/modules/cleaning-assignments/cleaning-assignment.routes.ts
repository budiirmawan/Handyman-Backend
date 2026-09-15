import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createCleaningAssignmentHandler,
  listCleaningAssignmentsHandler,
  listTeamDailyCleaningHandler,
  listWorkforceDailyCleaningHandler,
} from './cleaning-assignment.controller';

/**
 * BE-11D — Cleaning Assignment endpoints.
 *
 *   POST /housekeeping/daily-cleaning/:id/assignments
 *   GET  /housekeeping/daily-cleaning/:id/assignments
 *   GET  /workforce/:workforceId/housekeeping/daily-cleaning
 *   GET  /teams/:teamId/housekeeping/daily-cleaning
 */
export function createCleaningAssignmentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('cleaning_assignment.manage');
  const read = requirePermission('cleaning_assignment.read');

  router.post(
    '/housekeeping/daily-cleaning/:id/assignments',
    auth,
    manage,
    createCleaningAssignmentHandler,
  );
  router.get(
    '/housekeeping/daily-cleaning/:id/assignments',
    auth,
    read,
    listCleaningAssignmentsHandler,
  );
  router.get(
    '/workforce/:workforceId/housekeeping/daily-cleaning',
    auth,
    read,
    listWorkforceDailyCleaningHandler,
  );
  router.get(
    '/teams/:teamId/housekeeping/daily-cleaning',
    auth,
    read,
    listTeamDailyCleaningHandler,
  );

  return router;
}
