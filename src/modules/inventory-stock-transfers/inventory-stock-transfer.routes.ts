import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTransferHandler,
  getTransferHandler,
  listClientTransfersHandler,
  listTransfersHandler,
  listWarehouseTransfersHandler,
} from './inventory-stock-transfer.controller';

/**
 * BE-16E — Stock Transfer endpoints.
 *
 * Management (inventory_stock.manage):
 *   POST /stock-transfers
 *   POST /clients/:clientId/stock-transfers (same, client isolation)
 * Reads (inventory_stock.read or inventory_transfer.read):
 *   GET  /stock-transfers/:id
 *   GET  /stock-transfers (?clientId=&buildingId=&sourceWarehouseId=&destinationWarehouseId=&warehouseId=&itemId=&dateFrom=&dateTo=&reference=)
 *   GET  /clients/:clientId/stock-transfers (?buildingId=&sourceWarehouseId=&destinationWarehouseId=&warehouseId=&itemId=)
 *   GET  /warehouses/:warehouseId/stock-transfers (?itemId=&clientId=&buildingId=)
 *
 * Transaction-safe: source decrease, destination increase, transfer record, two movements.
 */
export function createInventoryStockTransferRouter(): Router {
  const router = Router();

  router.post(
    '/stock-transfers',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    createTransferHandler,
  );

  router.post(
    '/clients/:clientId/stock-transfers',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    createTransferHandler,
  );

  router.get(
    '/stock-transfers',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listTransfersHandler,
  );

  router.get(
    '/clients/:clientId/stock-transfers',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listClientTransfersHandler,
  );

  router.get(
    '/warehouses/:warehouseId/stock-transfers',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listWarehouseTransfersHandler,
  );

  router.get(
    '/stock-transfers/:id',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    getTransferHandler,
  );

  return router;
}
