import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  getUsageHandler,
  getWorkOrderMaterialCostSummaryHandler,
  listBuildingUsagesHandler,
  listClientUsagesHandler,
  listWorkOrderUsagesHandler,
  recordWorkOrderMaterialUsageHandler,
} from './inventory-wo-material-usage.controller';

/**
 * BE-16I — Work Order Material Usage endpoints.
 *
 * Management (work_order.manage or inventory_stock.manage):
 *   POST /work-orders/:workOrderId/material-usages
 * Reads (work_order.read or inventory_stock.read):
 *   GET  /work-orders/:workOrderId/material-usages (?warehouseId=&itemId=&clientId=&buildingId=&dateFrom=&dateTo=)
 *   GET  /buildings/:buildingId/work-order-material-usages
 *   GET  /clients/:clientId/work-order-material-usages
 *   GET  /work-order-material-usages/:id
 *
 * Transaction-safe stock-out reuse, approved Material Request demand linkage,
 * optional reservation consumption, and building isolation via Work Order building.
 */
export function createInventoryWorkOrderMaterialUsageRouter(): Router {
  const router = Router();

  router.post(
    '/work-orders/:workOrderId/material-usages',
    authenticationMiddleware,
    requirePermission('inventory_stock.manage'),
    recordWorkOrderMaterialUsageHandler,
  );

  router.get(
    '/work-orders/:workOrderId/material-usages',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listWorkOrderUsagesHandler,
  );

  // CR-BE-MAT-01 PART 05 — deterministic Work Order material-cost aggregation.
  router.get(
    '/work-orders/:workOrderId/material-cost-summary',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    getWorkOrderMaterialCostSummaryHandler,
  );

  router.get(
    '/buildings/:buildingId/work-order-material-usages',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    requireBuildingAccess('buildingId'),
    listBuildingUsagesHandler,
  );

  router.get(
    '/clients/:clientId/work-order-material-usages',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    listClientUsagesHandler,
  );

  router.get(
    '/work-order-material-usages/:id',
    authenticationMiddleware,
    requirePermission('inventory_stock.read'),
    getUsageHandler,
  );

  return router;
}
