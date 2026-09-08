import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSpaceHandler,
  getSpaceHandler,
  listRoomSpacesHandler,
  updateSpaceHandler,
} from './space.controller';

/**
 * BE-04F — Space endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation.
 *
 * Reads (`space.read`):    GET   /rooms/:roomId/spaces
 *                          GET   /spaces/:id
 * Management (`space.manage`): POST  /rooms/:roomId/spaces
 *                              PATCH /spaces/:id
 *
 * None of these routes carries a `buildingId` parameter, so every handler
 * resolves the parent Room to its Building (Room → Area → Floor → Building)
 * and asserts an ACTIVE assignment in the controller — Space administration
 * inherits BE-02 isolation rather than opening a side channel around it.
 *
 * `updateSpaceStatus` is service-level only; the API lifecycle path is the
 * general `PATCH /spaces/:id` (which accepts `status`).
 */
export function createSpaceRouter(): Router {
  const router = Router();

  router.post(
    '/rooms/:roomId/spaces',
    authenticationMiddleware,
    requirePermission('space.manage'),
    createSpaceHandler,
  );
  router.get(
    '/rooms/:roomId/spaces',
    authenticationMiddleware,
    requirePermission('space.read'),
    listRoomSpacesHandler,
  );
  router.get(
    '/spaces/:id',
    authenticationMiddleware,
    requirePermission('space.read'),
    getSpaceHandler,
  );
  router.patch(
    '/spaces/:id',
    authenticationMiddleware,
    requirePermission('space.manage'),
    updateSpaceHandler,
  );

  return router;
}
