import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  getBuildingHierarchyHandler,
  getFunctionalLocationContextHandler,
} from './structure-context.controller';

/**
 * BE-04H — Hierarchy & Operational Context endpoints, protected by BE-01
 * RBAC and BE-02 Building isolation. Read-only by design.
 *
 * GET /buildings/:buildingId/hierarchy      (`building.read`)
 *   The complete digital structure of one Building: floors → areas → rooms
 *   (with Room Type classification) → spaces (with pinned Functional
 *   Locations), plus Building-level Functional Locations.
 *
 * GET /functional-locations/:id/context     (`functional_location.read`)
 *   The authoritative operational location context behind one Functional
 *   Location — location hierarchy only, never Asset/Equipment records.
 *
 * No new permissions: hierarchy reads reuse the Building read capability and
 * context reads reuse the Functional Location read capability — BE-04H adds
 * no write surface and no new authority.
 */
export function createStructureContextRouter(): Router {
  const router = Router();

  router.get(
    '/buildings/:buildingId/hierarchy',
    authenticationMiddleware,
    requirePermission('building.read'),
    requireBuildingAccess('buildingId'),
    getBuildingHierarchyHandler,
  );
  router.get(
    '/functional-locations/:id/context',
    authenticationMiddleware,
    requirePermission('functional_location.read'),
    getFunctionalLocationContextHandler,
  );

  return router;
}
