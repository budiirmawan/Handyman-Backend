import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createAssetHandler,
  getAssetHandler,
  getAssetLocationHandler,
  getAssetStatusHandler,
  listBuildingAssetsHandler,
  updateAssetHandler,
  updateAssetLocationHandler,
  updateAssetStatusHandler,
} from './asset.controller';

/**
 * BE-05A — Asset Registry endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`asset.read`):
 *   GET   /buildings/:buildingId/assets   (?status= filter)
 *   GET   /assets/:id
 * Management (`asset.manage`):
 *   POST  /buildings/:buildingId/assets
 *   PATCH /assets/:id
 *
 * Building-nested routes pass through `requireBuildingAccess('buildingId')`;
 * the `/assets/:id` routes enforce the same rule in the controller after
 * resolving the Asset's Building — so Asset administration inherits BE-02
 * isolation rather than opening a side channel around it.
 *
 * `updateAssetStatus` is service-level only; the API path for basic
 * ACTIVE/INACTIVE is the general `PATCH /assets/:id` (which accepts `status`).
 *
 * BE-05C location binding adds two routes on the same permissions — no new
 * capability, because binding an Asset is Asset management, and reading its
 * resolved location is an Asset read:
 *   GET   /assets/:id/location   (`asset.read`)
 *   PATCH /assets/:id/location   (`asset.manage`)
 * Both return the authoritative BE-04H resolved context. Location binding is
 * also accepted by the general `PATCH /assets/:id` via `functionalLocationId`.
 *
 * BE-05E lifecycle status adds two more routes on the same permissions —
 * changing state is Asset management, reading it is an Asset read:
 *   GET   /assets/:assetId/status   (`asset.read`)
 *   PATCH /assets/:assetId/status   (`asset.manage`)
 * These are master/state operations only: no PM, breakdown, work order, or
 * maintenance execution endpoint is exposed.
 */
export function createAssetRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/assets',
    authenticationMiddleware,
    requirePermission('asset.manage'),
    requireBuildingAccess('buildingId'),
    createAssetHandler,
  );
  router.get(
    '/buildings/:buildingId/assets',
    authenticationMiddleware,
    requirePermission('asset.read'),
    requireBuildingAccess('buildingId'),
    listBuildingAssetsHandler,
  );
  router.get(
    '/assets/:id',
    authenticationMiddleware,
    requirePermission('asset.read'),
    getAssetHandler,
  );
  router.patch(
    '/assets/:id',
    authenticationMiddleware,
    requirePermission('asset.manage'),
    updateAssetHandler,
  );
  router.get(
    '/assets/:id/location',
    authenticationMiddleware,
    requirePermission('asset.read'),
    getAssetLocationHandler,
  );
  router.patch(
    '/assets/:id/location',
    authenticationMiddleware,
    requirePermission('asset.manage'),
    updateAssetLocationHandler,
  );
  router.get(
    '/assets/:assetId/status',
    authenticationMiddleware,
    requirePermission('asset.read'),
    getAssetStatusHandler,
  );
  router.patch(
    '/assets/:assetId/status',
    authenticationMiddleware,
    requirePermission('asset.manage'),
    updateAssetStatusHandler,
  );

  return router;
}
