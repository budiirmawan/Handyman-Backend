import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  getMinimumStockHandler,
  listBuildingMinimumStocksHandler,
  listClientMinimumStocksHandler,
  listWarehouseMinimumStocksHandler,
  setClientMinimumStockHandler,
  setWarehouseMinimumStockHandler,
  updateMinimumStockHandler,
} from './inventory-minimum-stock.controller';

/**
 * BE-16G — Minimum Stock threshold endpoints.
 *
 * Management (inventory_stock.manage):
 *   POST /warehouses/:warehouseId/minimum-stocks
 *   POST /clients/:clientId/minimum-stocks
 *   PATCH /minimum-stocks/:id
 * Reads (inventory_stock.read):
 *   GET /warehouses/:warehouseId/minimum-stocks (?itemId=&status=&readiness=)
 *   GET /buildings/:buildingId/minimum-stocks
 *   GET /clients/:clientId/minimum-stocks
 *   GET /minimum-stocks/:id
 *
 * Readiness resolved: available < minimum => LOW_STOCK else OK, UNKNOWN if no balance and inactive.
 */
export function createInventoryMinimumStockRouter(): Router {
  const router = Router();

  router.post(
    '/warehouses/:warehouseId/minimum-stocks',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    setWarehouseMinimumStockHandler,
  );

  router.post(
    '/clients/:clientId/minimum-stocks',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    setClientMinimumStockHandler,
  );

  router.patch(
    '/minimum-stocks/:id',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    updateMinimumStockHandler,
  );

  router.get(
    '/warehouses/:warehouseId/minimum-stocks',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listWarehouseMinimumStocksHandler,
  );

  router.get(
    '/buildings/:buildingId/minimum-stocks',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    requireBuildingAccess('buildingId'),
    listBuildingMinimumStocksHandler,
  );

  router.get(
    '/clients/:clientId/minimum-stocks',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listClientMinimumStocksHandler,
  );

  router.get(
    '/minimum-stocks/:id',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    getMinimumStockHandler,
  );

  return router;
}
