import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  getDailyCleaningHandler,
  listAreaDailyCleaningHandler,
  listDailyCleaningByBuildingHandler,
} from './daily-cleaning.controller';

/**
 * BE-11C — Daily Cleaning endpoints.
 *
 *   GET /buildings/:buildingId/housekeeping/daily-cleaning
 *   GET /housekeeping/daily-cleaning/:id
 *   GET /housekeeping/cleaning-areas/:id/daily-cleaning
 */
export function createDailyCleaningRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('daily_cleaning.read');

  router.get(
    '/buildings/:buildingId/housekeeping/daily-cleaning',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listDailyCleaningByBuildingHandler,
  );
  router.get(
    '/housekeeping/daily-cleaning/:id',
    auth,
    read,
    getDailyCleaningHandler,
  );
  router.get(
    '/housekeeping/cleaning-areas/:id/daily-cleaning',
    auth,
    read,
    listAreaDailyCleaningHandler,
  );

  return router;
}
