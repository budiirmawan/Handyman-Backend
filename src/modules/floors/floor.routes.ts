import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createFloorHandler,
  getFloorHandler,
  listBuildingFloorsHandler,
  updateFloorHandler,
} from './floor.controller';

/**
 * BE-04A — Floor endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation.
 *
 * Reads (`floor.read`):    GET   /buildings/:buildingId/floors
 *                          GET   /floors/:id
 * Management (`floor.manage`): POST  /buildings/:buildingId/floors
 *                              PATCH /floors/:id
 *
 * Building-nested routes additionally pass through
 * `requireBuildingAccess('buildingId')`, so holding `floor.read`/`floor.manage`
 * is not enough — the caller must also have an ACTIVE assignment to that
 * Building. The `/floors/:id` routes enforce the same rule in the controller
 * (after resolving the Floor's Building), so Floor administration inherits
 * BE-02 isolation rather than opening a side channel around it.
 *
 * `updateFloorStatus` is service-level only; the API lifecycle path is the
 * general `PATCH /floors/:id` (which accepts `status`).
 */
export function createFloorRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/floors',
    authenticationMiddleware,
    requirePermission('floor.manage'),
    requireBuildingAccess('buildingId'),
    createFloorHandler,
  );
  router.get(
    '/buildings/:buildingId/floors',
    authenticationMiddleware,
    requirePermission('floor.read'),
    requireBuildingAccess('buildingId'),
    listBuildingFloorsHandler,
  );
  router.get(
    '/floors/:id',
    authenticationMiddleware,
    requirePermission('floor.read'),
    getFloorHandler,
  );
  router.patch(
    '/floors/:id',
    authenticationMiddleware,
    requirePermission('floor.manage'),
    updateFloorHandler,
  );

  return router;
}
