import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  getStockBalanceHandler,
  initializeStockBalanceHandler,
  initializeWarehouseStockBalanceHandler,
  listBuildingStockBalancesHandler,
  listClientStockBalancesHandler,
  listWarehouseStockBalancesHandler,
} from './inventory-stock-balance.controller';

/**
 * BE-16C — Stock Balance endpoints.
 *
 * Management (inventory_stock.manage): initialize balance
 *   POST /warehouses/:warehouseId/stock-balances
 *   POST /clients/:clientId/stock-balances (alternative with warehouseId in body)
 * Reads (inventory_stock.read):
 *   GET  /warehouses/:warehouseId/stock-balances (?itemId=)
 *   GET  /buildings/:buildingId/stock-balances (?warehouseId=&itemId=&clientId=)
 *   GET  /clients/:clientId/stock-balances (?buildingId=&warehouseId=&itemId=)
 *   GET  /stock-balances/:id
 *
 * Building isolation via warehouse → building resolution; service asserts building access.
 * No quantity PATCH here — BE-16D will own movement.
 */
export function createInventoryStockBalanceRouter(): Router {
  const router = Router();

  router.post(
    '/warehouses/:warehouseId/stock-balances',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    initializeWarehouseStockBalanceHandler,
  );

  router.post(
    '/clients/:clientId/stock-balances',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    initializeStockBalanceHandler,
  );

  router.get(
    '/warehouses/:warehouseId/stock-balances',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listWarehouseStockBalancesHandler,
  );

  router.get(
    '/buildings/:buildingId/stock-balances',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    requireBuildingAccess('buildingId'),
    listBuildingStockBalancesHandler,
  );

  router.get(
    '/clients/:clientId/stock-balances',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listClientStockBalancesHandler,
  );

  router.get(
    '/stock-balances/:id',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    getStockBalanceHandler,
  );

  return router;
}
