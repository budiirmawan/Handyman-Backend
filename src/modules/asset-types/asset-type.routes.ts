import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createAssetTypeHandler,
  getAssetTypeHandler,
  listCategoryAssetTypesHandler,
  updateAssetTypeHandler,
} from './asset-type.controller';

/**
 * BE-05B — Asset Type endpoints, protected by BE-01 RBAC.
 *
 * Reads (`asset_type.read`):
 *   GET   /asset-categories/:categoryId/types
 *   GET   /asset-types/:id
 * Management (`asset_type.manage`):
 *   POST  /asset-categories/:categoryId/types
 *   PATCH /asset-types/:id
 *
 * Asset Types are nested under their Category, so the owning Category — and
 * therefore the Client, derived Type → Category → Client — is always taken
 * from the URL. Cross-Client enforcement happens where the reference is USED:
 * assigning a classification to an Asset (PATCH /assets/:id) rejects any Type
 * whose Category belongs to a different Client.
 *
 * `updateAssetTypeStatus` is service-level only; the API lifecycle path is
 * the general `PATCH /asset-types/:id` (which accepts `status`).
 */
export function createAssetTypeRouter(): Router {
  const router = Router();

  router.post(
    '/asset-categories/:categoryId/types',
    authenticationMiddleware,
    requirePermission('asset_type.manage'),
    createAssetTypeHandler,
  );
  router.get(
    '/asset-categories/:categoryId/types',
    authenticationMiddleware,
    requirePermission('asset_type.read'),
    listCategoryAssetTypesHandler,
  );
  router.get(
    '/asset-types/:id',
    authenticationMiddleware,
    requirePermission('asset_type.read'),
    getAssetTypeHandler,
  );
  router.patch(
    '/asset-types/:id',
    authenticationMiddleware,
    requirePermission('asset_type.manage'),
    updateAssetTypeHandler,
  );

  return router;
}
