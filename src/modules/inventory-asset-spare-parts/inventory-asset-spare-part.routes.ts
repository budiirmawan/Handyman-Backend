import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  bindSparePartHandler,
  getBindingHandler,
  listAssetsBySparePartHandler,
  listSparePartsByAssetHandler,
  updateBindingHandler,
} from './inventory-asset-spare-part.controller';

/**
 * BE-16H — Asset Spare Part Binding endpoints.
 *
 * Management (asset.manage or inventory_item.manage):
 *   POST /assets/:assetId/spare-parts
 *   PATCH /asset-spare-parts/:id
 * Reads (asset.read or inventory_item.read):
 *   GET /assets/:assetId/spare-parts (?itemId=&status=)
 *   GET /inventory-items/:itemId/asset-bindings (?assetId=&status=)
 *   GET /asset-spare-parts/:id
 *
 * We reuse asset.manage/read for RBAC (asset side) — spare part binding is asset-related
 * but owned by inventory domain (BE-16 owns inventory/stock records, not asset duplication).
 * Building isolation via asset's building.
 */
export function createInventoryAssetSparePartRouter(): Router {
  const router = Router();

  router.post(
    '/assets/:assetId/spare-parts',
    authenticationMiddleware,
    requirePermission('asset.manage'),
    bindSparePartHandler,
  );

  router.get(
    '/assets/:assetId/spare-parts',
    authenticationMiddleware,
    requirePermission('asset.read'),
    listSparePartsByAssetHandler,
  );

  router.get(
    '/inventory-items/:itemId/asset-bindings',
    authenticationMiddleware,
    requirePermission('inventory_item.read'),
    listAssetsBySparePartHandler,
  );

  router.get(
    '/asset-spare-parts/:id',
    authenticationMiddleware,
    requirePermission('asset.read'),
    getBindingHandler,
  );

  router.patch(
    '/asset-spare-parts/:id',
    authenticationMiddleware,
    requirePermission('asset.manage'),
    updateBindingHandler,
  );

  return router;
}
