import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createCleaningAreaHandler,
  getCleaningAreaHandler,
  listBuildingCleaningAreasHandler,
  updateCleaningAreaHandler,
} from './cleaning-area.controller';

/**
 * BE-11A — Cleaning Area endpoints.
 *
 *   POST  /buildings/:buildingId/cleaning-areas
 *   GET   /buildings/:buildingId/cleaning-areas
 *   GET   /housekeeping/cleaning-areas/:id
 *   PATCH /housekeeping/cleaning-areas/:id
 */
export function createCleaningAreaRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('cleaning_area.manage');
  const read = requirePermission('cleaning_area.read');

  router.post(
    '/buildings/:buildingId/cleaning-areas',
    auth,
    manage,
    requireBuildingAccess('buildingId'),
    createCleaningAreaHandler,
  );
  router.get(
    '/buildings/:buildingId/cleaning-areas',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingCleaningAreasHandler,
  );
  router.get(
    '/housekeeping/cleaning-areas/:id',
    auth,
    read,
    getCleaningAreaHandler,
  );
  router.patch(
    '/housekeeping/cleaning-areas/:id',
    auth,
    manage,
    updateCleaningAreaHandler,
  );

  return router;
}
