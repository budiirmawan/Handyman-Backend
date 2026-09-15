import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  getAdjustmentHandler,
  listBuildingAdjustmentsHandler,
  listClientAdjustmentsHandler,
  listWarehouseAdjustmentsHandler,
  postClientAdjustmentHandler,
  postWarehouseAdjustmentHandler,
} from './inventory-stock-adjustment.controller';

/**
 * BE-16F — Stock Adjustment endpoints.
 *
 * Management (inventory_stock.manage):
 *   POST /warehouses/:warehouseId/adjustments
 *   POST /clients/:clientId/adjustments
 * Reads (inventory_stock.read):
 *   GET  /warehouses/:warehouseId/adjustments (?itemId=&adjustmentType=&dateFrom=&dateTo=&reference=)
 *   GET  /buildings/:buildingId/adjustments
 *   GET  /clients/:clientId/adjustments
 *   GET  /adjustments/:id
 *
 * No PATCH/DELETE — immutability.
 * Transaction-safe balance update.
 */
export function createInventoryStockAdjustmentRouter(): Router {
  const router = Router();

  router.post(
    '/warehouses/:warehouseId/adjustments',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    postWarehouseAdjustmentHandler,
  );

  router.post(
    '/clients/:clientId/adjustments',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    postClientAdjustmentHandler,
  );

  router.get(
    '/warehouses/:warehouseId/adjustments',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listWarehouseAdjustmentsHandler,
  );

  router.get(
    '/buildings/:buildingId/adjustments',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    requireBuildingAccess('buildingId'),
    listBuildingAdjustmentsHandler,
  );

  router.get(
    '/clients/:clientId/adjustments',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listClientAdjustmentsHandler,
  );

  router.get(
    '/adjustments/:id',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    getAdjustmentHandler,
  );

  return router;
}
