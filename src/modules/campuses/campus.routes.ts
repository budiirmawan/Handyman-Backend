import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createCampusHandler,
  getCampusHandler,
  listPropertyCampusesHandler,
  setBuildingCampusHandler,
  updateCampusHandler,
} from './campus.controller';

/**
 * BE-04B — Campus endpoints, protected by RBAC.
 *
 * Reads (`campus.read`):    GET   /properties/:propertyId/campuses
 *                           GET   /campuses/:id
 * Management (`campus.manage`): POST  /properties/:propertyId/campuses
 *                               PATCH /campuses/:id
 *                               PATCH /buildings/:buildingId/campus
 *
 * Campus administration is Property-level structure administration, so the
 * Property-scoped routes follow the Property/Building route convention (RBAC
 * without a per-Building assignment check — there is no Building in scope
 * yet). The one route that touches a concrete Building — the association
 * endpoint — additionally passes through `requireBuildingAccess`, so it
 * inherits BE-02 Building isolation like every other Building-scoped
 * operation.
 *
 * `updateCampusStatus` is service-level only; the API lifecycle path is the
 * general `PATCH /campuses/:id` (which accepts `status`).
 */
export function createCampusRouter(): Router {
  const router = Router();

  router.post(
    '/properties/:propertyId/campuses',
    authenticationMiddleware,
    requirePermission('campus.manage'),
    createCampusHandler,
  );
  router.get(
    '/properties/:propertyId/campuses',
    authenticationMiddleware,
    requirePermission('campus.read'),
    listPropertyCampusesHandler,
  );
  router.get(
    '/campuses/:id',
    authenticationMiddleware,
    requirePermission('campus.read'),
    getCampusHandler,
  );
  router.patch(
    '/campuses/:id',
    authenticationMiddleware,
    requirePermission('campus.manage'),
    updateCampusHandler,
  );

  router.patch(
    '/buildings/:buildingId/campus',
    authenticationMiddleware,
    requirePermission('campus.manage'),
    requireBuildingAccess('buildingId'),
    setBuildingCampusHandler,
  );

  return router;
}
