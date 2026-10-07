import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createAssignmentHandler,
  currentUserBuildingsHandler,
  deactivateAssignmentHandler,
  listUserBuildingsHandler,
} from './building-assignment.controller';

/**
 * User / Building Assignment endpoints, protected by RBAC.
 *
 * Management (`building.manage`): POST /users/:userId/buildings,
 *   DELETE /users/:userId/buildings/:buildingId.
 * Read (`building.read`): GET /users/:userId/buildings.
 *
 * Current-user context (authentication only): GET /auth/me/buildings.
 * A User may retrieve their OWN available Building assignments without a
 * management permission.
 */
export function createBuildingAssignmentRouter(): Router {
  const router = Router();

  router.post(
    '/users/:userId/buildings',
    authenticationMiddleware,
    requirePermission('building.manage'),
    createAssignmentHandler,
  );
  router.get(
    '/users/:userId/buildings',
    authenticationMiddleware,
    requirePermission('building.read'),
    listUserBuildingsHandler,
  );
  router.delete(
    '/users/:userId/buildings/:buildingId',
    authenticationMiddleware,
    requirePermission('building.manage'),
    deactivateAssignmentHandler,
  );

  router.get(
    '/auth/me/buildings',
    authenticationMiddleware,
    currentUserBuildingsHandler,
  );

  return router;
}
