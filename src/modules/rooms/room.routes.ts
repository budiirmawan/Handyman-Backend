import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createRoomHandler,
  getRoomHandler,
  listAreaRoomsHandler,
  updateRoomHandler,
} from './room.controller';

/**
 * BE-04D — Room endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation.
 *
 * Reads (`room.read`):    GET   /areas/:areaId/rooms
 *                         GET   /rooms/:id
 * Management (`room.manage`): POST  /areas/:areaId/rooms
 *                             PATCH /rooms/:id
 *
 * None of these routes carries a `buildingId` parameter, so every handler
 * resolves the parent Area to its Building (Area → Floor → Building) and
 * asserts an ACTIVE assignment in the controller — Room administration
 * inherits BE-02 isolation rather than opening a side channel around it.
 *
 * `updateRoomStatus` is service-level only; the API lifecycle path is the
 * general `PATCH /rooms/:id` (which accepts `status`).
 */
export function createRoomRouter(): Router {
  const router = Router();

  router.post(
    '/areas/:areaId/rooms',
    authenticationMiddleware,
    requirePermission('room.manage'),
    createRoomHandler,
  );
  router.get(
    '/areas/:areaId/rooms',
    authenticationMiddleware,
    requirePermission('room.read'),
    listAreaRoomsHandler,
  );
  router.get(
    '/rooms/:id',
    authenticationMiddleware,
    requirePermission('room.read'),
    getRoomHandler,
  );
  router.patch(
    '/rooms/:id',
    authenticationMiddleware,
    requirePermission('room.manage'),
    updateRoomHandler,
  );

  return router;
}
