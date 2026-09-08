import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createBuildingHandler,
  getBuildingHandler,
  listBuildingsHandler,
  listPropertyBuildingsHandler,
  updateBuildingStatusHandler,
} from './building.controller';

/**
 * Building management endpoints, protected by RBAC.
 *
 * Reads (`building.read`): GET /buildings, GET /buildings/:id,
 *   GET /properties/:propertyId/buildings.
 * Management (`building.manage`): POST /buildings, PATCH /buildings/:id/status.
 */
export function createBuildingRouter(): Router {
  const router = Router();

  router.post(
    '/buildings',
    authenticationMiddleware,
    requirePermission('building.manage'),
    createBuildingHandler,
  );
  router.get(
    '/buildings',
    authenticationMiddleware,
    requirePermission('building.read'),
    listBuildingsHandler,
  );
  router.get(
    '/buildings/:id',
    authenticationMiddleware,
    requirePermission('building.read'),
    requireBuildingAccess('id'),
    getBuildingHandler,
  );
  router.patch(
    '/buildings/:id/status',
    authenticationMiddleware,
    requirePermission('building.manage'),
    updateBuildingStatusHandler,
  );

  router.get(
    '/properties/:propertyId/buildings',
    authenticationMiddleware,
    requirePermission('building.read'),
    listPropertyBuildingsHandler,
  );

  return router;
}
