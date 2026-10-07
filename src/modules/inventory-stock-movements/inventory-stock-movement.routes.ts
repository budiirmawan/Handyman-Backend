import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  getMovementHandler,
  listBuildingMovementsHandler,
  listClientMovementsHandler,
  listWarehouseMovementsHandler,
  postClientStockMovementHandler,
  postWarehouseStockMovementHandler,
} from './inventory-stock-movement.controller';

/**
 * BE-16D — Stock In / Out movement endpoints.
 *
 * Management (inventory_stock.manage):
 *   POST /warehouses/:warehouseId/stock-movements
 *   POST /clients/:clientId/stock-movements (alternative with warehouseId in body)
 * Reads (inventory_stock.read):
 *   GET  /warehouses/:warehouseId/stock-movements (?itemId=&movementType=&dateFrom=&dateTo=&reference=)
 *   GET  /buildings/:buildingId/stock-movements (?warehouseId=&itemId=&movementType=&dateFrom=&dateTo=)
 *   GET  /clients/:clientId/stock-movements (?buildingId=&warehouseId=&itemId=&movementType=&dateFrom=&dateTo=)
 *   GET  /stock-movements/:id
 *
 * No PATCH/DELETE — immutability.
 * Transaction-safe: movement + balance update in one transaction with FOR UPDATE lock.
 */
export function createInventoryStockMovementRouter(): Router {
  const router = Router();

  router.post(
    '/warehouses/:warehouseId/stock-movements',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    postWarehouseStockMovementHandler,
  );

  router.post(
    '/clients/:clientId/stock-movements',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    postClientStockMovementHandler,
  );

  router.get(
    '/warehouses/:warehouseId/stock-movements',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listWarehouseMovementsHandler,
  );

  router.get(
    '/buildings/:buildingId/stock-movements',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    requireBuildingAccess('buildingId'),
    listBuildingMovementsHandler,
  );

  router.get(
    '/clients/:clientId/stock-movements',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listClientMovementsHandler,
  );

  router.get(
    '/stock-movements/:id',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    getMovementHandler,
  );

  return router;
}
