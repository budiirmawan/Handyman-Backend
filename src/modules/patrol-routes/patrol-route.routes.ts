import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  addPatrolRoutePointHandler,
  createPatrolRouteHandler,
  getPatrolRouteHandler,
  listBuildingPatrolRoutesHandler,
  listPatrolRoutePointsHandler,
  updatePatrolRouteHandler,
  updatePatrolRoutePointHandler,
} from './patrol-route.controller';

/**
 * BE-12B — Patrol Route endpoints.
 *
 *   POST  /buildings/:buildingId/security/patrol-routes
 *   GET   /buildings/:buildingId/security/patrol-routes
 *   GET   /security/patrol-routes/:id
 *   PATCH /security/patrol-routes/:id
 *   POST  /security/patrol-routes/:id/points
 *   GET   /security/patrol-routes/:id/points
 *   PATCH /security/patrol-route-points/:id
 *
 * A Patrol Route is the Security operational definition of an ordered
 * patrol sequence. It is NOT a schedule, task, or execution — those
 * belong to later BE-12 PARTs.
 */
export function createPatrolRouteRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('patrol_route.manage');
  const read = requirePermission('patrol_route.read');

  router.post(
    '/buildings/:buildingId/security/patrol-routes',
    auth,
    manage,
    requireBuildingAccess('buildingId'),
    createPatrolRouteHandler,
  );
  router.get(
    '/buildings/:buildingId/security/patrol-routes',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listBuildingPatrolRoutesHandler,
  );
  router.get(
    '/security/patrol-routes/:id',
    auth,
    read,
    getPatrolRouteHandler,
  );
  router.patch(
    '/security/patrol-routes/:id',
    auth,
    manage,
    updatePatrolRouteHandler,
  );

  // Points
  router.post(
    '/security/patrol-routes/:id/points',
    auth,
    manage,
    addPatrolRoutePointHandler,
  );
  router.get(
    '/security/patrol-routes/:id/points',
    auth,
    read,
    listPatrolRoutePointsHandler,
  );
  router.patch(
    '/security/patrol-route-points/:id',
    auth,
    manage,
    updatePatrolRoutePointHandler,
  );

  return router;
}
