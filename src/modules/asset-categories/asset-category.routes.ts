import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createAssetCategoryHandler,
  getAssetCategoryHandler,
  listClientAssetCategoriesHandler,
  updateAssetCategoryHandler,
} from './asset-category.controller';

/**
 * BE-05B — Asset Category endpoints, protected by BE-01 RBAC.
 *
 * Reads (`asset_category.read`):
 *   GET   /clients/:clientId/asset-categories
 *   GET   /asset-categories/:id
 * Management (`asset_category.manage`):
 *   POST  /clients/:clientId/asset-categories
 *   PATCH /asset-categories/:id
 *
 * Asset Categories are Client-scoped reference data, so routes follow the
 * BE-04E Room Type convention: writes and Client-scoped reads are nested
 * under the Client, so the owning Client is always taken from the URL (BE-02
 * isolation). Cross-Client enforcement happens where the reference is USED:
 * assigning a classification to an Asset (PATCH /assets/:id) rejects any
 * Category of a different Client.
 *
 * `updateAssetCategoryStatus` is service-level only; the API lifecycle path
 * is the general `PATCH /asset-categories/:id` (which accepts `status`).
 */
export function createAssetCategoryRouter(): Router {
  const router = Router();

  router.post(
    '/clients/:clientId/asset-categories',
    authenticationMiddleware,
    requirePermission('asset_category.manage'),
    createAssetCategoryHandler,
  );
  router.get(
    '/clients/:clientId/asset-categories',
    authenticationMiddleware,
    requirePermission('asset_category.read'),
    listClientAssetCategoriesHandler,
  );
  router.get(
    '/asset-categories/:id',
    authenticationMiddleware,
    requirePermission('asset_category.read'),
    getAssetCategoryHandler,
  );
  router.patch(
    '/asset-categories/:id',
    authenticationMiddleware,
    requirePermission('asset_category.manage'),
    updateAssetCategoryHandler,
  );

  return router;
}
