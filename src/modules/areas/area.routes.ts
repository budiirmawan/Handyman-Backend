import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createAreaHandler,
  getAreaHandler,
  listFloorAreasHandler,
  updateAreaHandler,
} from './area.controller';

/**
 * BE-04C — Area / Zone endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation.
 *
 * Reads (`area.read`):    GET   /floors/:floorId/areas
 *                         GET   /areas/:id
 * Management (`area.manage`): POST  /floors/:floorId/areas
 *                             PATCH /areas/:id
 *
 * `/areas` is the single route convention (one Area entity classifies itself
 * as AREA or ZONE via `type` — no parallel `/zones` surface). None of these
 * routes carries a `buildingId` parameter, so every handler resolves the
 * parent Floor to its Building and asserts an ACTIVE assignment in the
 * controller — Area administration inherits BE-02 isolation rather than
 * opening a side channel around it.
 *
 * `updateAreaStatus` is service-level only; the API lifecycle path is the
 * general `PATCH /areas/:id` (which accepts `status`).
 */
export function createAreaRouter(): Router {
  const router = Router();

  router.post(
    '/floors/:floorId/areas',
    authenticationMiddleware,
    requirePermission('area.manage'),
    createAreaHandler,
  );
  router.get(
    '/floors/:floorId/areas',
    authenticationMiddleware,
    requirePermission('area.read'),
    listFloorAreasHandler,
  );
  router.get(
    '/areas/:id',
    authenticationMiddleware,
    requirePermission('area.read'),
    getAreaHandler,
  );
  router.patch(
    '/areas/:id',
    authenticationMiddleware,
    requirePermission('area.manage'),
    updateAreaHandler,
  );

  return router;
}
