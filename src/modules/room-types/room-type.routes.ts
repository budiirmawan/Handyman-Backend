import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createRoomTypeHandler,
  getRoomTypeHandler,
  listClientRoomTypesHandler,
  updateRoomTypeHandler,
} from './room-type.controller';

/**
 * BE-04E — Room Type endpoints, protected by BE-01 RBAC.
 *
 * Reads (`room_type.read`):    GET   /clients/:clientId/room-types
 *                              GET   /room-types/:id
 * Management (`room_type.manage`): POST  /clients/:clientId/room-types
 *                                  PATCH /room-types/:id
 *
 * Room Types are Client-scoped reference data, so routes follow the BE-03D1
 * Skill catalog convention: writes and Client-scoped reads are nested under
 * the Client, so the owning Client is always taken from the URL (BE-02
 * isolation). Cross-Client enforcement happens where the reference is USED:
 * assigning a Room Type to a Room (PATCH /rooms/:id) rejects any Room Type
 * of a different Client.
 *
 * `updateRoomTypeStatus` is service-level only; the API lifecycle path is
 * the general `PATCH /room-types/:id` (which accepts `status`).
 */
export function createRoomTypeRouter(): Router {
  const router = Router();

  router.post(
    '/clients/:clientId/room-types',
    authenticationMiddleware,
    requirePermission('room_type.manage'),
    createRoomTypeHandler,
  );
  router.get(
    '/clients/:clientId/room-types',
    authenticationMiddleware,
    requirePermission('room_type.read'),
    listClientRoomTypesHandler,
  );
  router.get(
    '/room-types/:id',
    authenticationMiddleware,
    requirePermission('room_type.read'),
    getRoomTypeHandler,
  );
  router.patch(
    '/room-types/:id',
    authenticationMiddleware,
    requirePermission('room_type.manage'),
    updateRoomTypeHandler,
  );

  return router;
}
