import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createFunctionalLocationHandler,
  getFunctionalLocationHandler,
  listBuildingFunctionalLocationsHandler,
  updateFunctionalLocationHandler,
} from './functional-location.controller';

/**
 * BE-04G — Functional Location endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`functional_location.read`):
 *   GET   /buildings/:buildingId/functional-locations   (?spaceId= filter)
 *   GET   /functional-locations/:id
 * Management (`functional_location.manage`):
 *   POST  /buildings/:buildingId/functional-locations
 *   PATCH /functional-locations/:id
 *
 * Building-nested routes pass through `requireBuildingAccess('buildingId')`;
 * the `/functional-locations/:id` routes enforce the same rule in the
 * controller after resolving the record's Building — so Functional Location
 * administration inherits BE-02 isolation rather than opening a side channel
 * around it. Space scoping is a `?spaceId=` filter on the Building list (no
 * duplicate API surface).
 *
 * `updateFunctionalLocationStatus` is service-level only; the API lifecycle
 * path is the general `PATCH /functional-locations/:id` (which accepts
 * `status`).
 */
export function createFunctionalLocationRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/functional-locations',
    authenticationMiddleware,
    requirePermission('functional_location.manage'),
    requireBuildingAccess('buildingId'),
    createFunctionalLocationHandler,
  );
  router.get(
    '/buildings/:buildingId/functional-locations',
    authenticationMiddleware,
    requirePermission('functional_location.read'),
    requireBuildingAccess('buildingId'),
    listBuildingFunctionalLocationsHandler,
  );
  router.get(
    '/functional-locations/:id',
    authenticationMiddleware,
    requirePermission('functional_location.read'),
    getFunctionalLocationHandler,
  );
  router.patch(
    '/functional-locations/:id',
    authenticationMiddleware,
    requirePermission('functional_location.manage'),
    updateFunctionalLocationHandler,
  );

  return router;
}
