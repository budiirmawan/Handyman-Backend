import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createEquipmentProfileHandler,
  getEquipmentProfileHandler,
  updateEquipmentProfileHandler,
} from './equipment-profile.controller';

/**
 * BE-05D — Equipment Profile endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`equipment_profile.read`):
 *   GET   /assets/:assetId/equipment-profile
 * Management (`equipment_profile.manage`):
 *   POST  /assets/:assetId/equipment-profile
 *   PATCH /assets/:assetId/equipment-profile
 *
 * The Profile is a singleton per Asset, so the route is the singular
 * `/equipment-profile` rather than a collection — there is no list endpoint
 * and no id in the path.
 *
 * Dedicated permissions (rather than reusing `asset.*`) because technical
 * equipment data is a distinct engineering capability from asset
 * administration.
 *
 * `updateEquipmentProfileStatus` is service-level only; the API path for
 * ACTIVE/INACTIVE is the general PATCH (which accepts `status`). No
 * maintenance or operational endpoints are exposed here.
 */
export function createEquipmentProfileRouter(): Router {
  const router = Router();

  router.post(
    '/assets/:assetId/equipment-profile',
    authenticationMiddleware,
    requirePermission('equipment_profile.manage'),
    createEquipmentProfileHandler,
  );
  router.get(
    '/assets/:assetId/equipment-profile',
    authenticationMiddleware,
    requirePermission('equipment_profile.read'),
    getEquipmentProfileHandler,
  );
  router.patch(
    '/assets/:assetId/equipment-profile',
    authenticationMiddleware,
    requirePermission('equipment_profile.manage'),
    updateEquipmentProfileHandler,
  );

  return router;
}
