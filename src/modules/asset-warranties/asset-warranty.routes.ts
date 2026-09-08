import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createAssetWarrantyHandler,
  getCurrentAssetWarrantyHandler,
  listAssetWarrantiesHandler,
  updateAssetWarrantyHandler,
} from './asset-warranty.controller';

/**
 * BE-05F — Asset Warranty endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`asset_warranty.read`):
 *   GET   /assets/:assetId/warranties          (history, `?status=` filter)
 *   GET   /assets/:assetId/warranty            (current ACTIVE coverage)
 * Management (`asset_warranty.manage`):
 *   POST  /assets/:assetId/warranties
 *   PATCH /assets/:assetId/warranties/:warrantyId
 *
 * The plural route is the coverage HISTORY (many records per Asset); the
 * singular route is the one current coverage. Dedicated permissions because
 * commercial coverage is a distinct capability from asset administration and
 * from engineering data.
 *
 * Status changes travel through the general PATCH (which accepts `status`).
 * No vendor contract, claim workflow, or maintenance endpoint is exposed.
 */
export function createAssetWarrantyRouter(): Router {
  const router = Router();

  router.post(
    '/assets/:assetId/warranties',
    authenticationMiddleware,
    requirePermission('asset_warranty.manage'),
    createAssetWarrantyHandler,
  );
  router.get(
    '/assets/:assetId/warranties',
    authenticationMiddleware,
    requirePermission('asset_warranty.read'),
    listAssetWarrantiesHandler,
  );
  router.get(
    '/assets/:assetId/warranty',
    authenticationMiddleware,
    requirePermission('asset_warranty.read'),
    getCurrentAssetWarrantyHandler,
  );
  router.patch(
    '/assets/:assetId/warranties/:warrantyId',
    authenticationMiddleware,
    requirePermission('asset_warranty.manage'),
    updateAssetWarrantyHandler,
  );

  return router;
}
