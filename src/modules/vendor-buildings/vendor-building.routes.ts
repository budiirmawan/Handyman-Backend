import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  assignVendorBuildingHandler,
  listBuildingVendorsHandler,
  listVendorBuildingsHandler,
  updateVendorBuildingHandler,
} from './vendor-building.controller';

/**
 * BE-06D — Vendor Building Relationship endpoints, protected by BE-01 RBAC.
 *
 * Reuses the BE-06A vendor permissions rather than introducing new codes:
 *   `vendor.read`   → GET   /vendors/:vendorId/buildings
 *                     GET   /buildings/:buildingId/vendors
 *   `vendor.manage` → POST  /vendors/:vendorId/buildings
 *                     PATCH /vendors/:vendorId/buildings/:buildingId
 *
 * The Building-nested route additionally passes through BE-02G
 * `requireBuildingAccess`, matching the BE-03G precedent: reading a
 * Building's vendor roster is reading that Building's data, so the caller's
 * own BE-02F access still applies. Note the direction — access is *required
 * to read*, never *granted by* these relationships.
 *
 * Deactivation is a PATCH with `{ "status": "INACTIVE" }`, not a DELETE, so
 * the relationship history survives.
 */
export function createVendorBuildingRouter(): Router {
  const router = Router();

  router.post(
    '/vendors/:vendorId/buildings',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    assignVendorBuildingHandler,
  );
  router.get(
    '/vendors/:vendorId/buildings',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    listVendorBuildingsHandler,
  );
  router.get(
    '/buildings/:buildingId/vendors',
    authenticationMiddleware,
    requirePermission('vendor.read'),
    requireBuildingAccess('buildingId'),
    listBuildingVendorsHandler,
  );
  router.patch(
    '/vendors/:vendorId/buildings/:buildingId',
    authenticationMiddleware,
    requirePermission('vendor.manage'),
    updateVendorBuildingHandler,
  );

  return router;
}
