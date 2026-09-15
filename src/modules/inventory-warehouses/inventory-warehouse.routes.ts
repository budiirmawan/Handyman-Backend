import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createWarehouseHandler,
  getWarehouseHandler,
  listBuildingWarehousesHandler,
  listClientWarehousesHandler,
  updateWarehouseHandler,
  updateWarehouseStatusHandler,
} from './inventory-warehouse.controller';

/**
 * BE-16B — Warehouse / Store endpoints, protected by BE-01 RBAC and BE-02 Building/Client isolation.
 *
 * Management (inventory_warehouse.manage):
 *   POST  /buildings/:buildingId/warehouses
 *   PATCH /warehouses/:id
 *   PATCH /warehouses/:id/status
 * Reads (inventory_warehouse.read):
 *   GET   /buildings/:buildingId/warehouses   (?status=&search=&functionalLocationId=)
 *   GET   /clients/:clientId/warehouses       (?buildingId=&status=&search=) optional client view
 *   GET   /warehouses/:id
 *
 * Building-nested routes use requireBuildingAccess('buildingId') same as asset routes.
 * /warehouses/:id routes enforce building isolation inside controller via service after resolving building.
 * No stock/movement here.
 */
export function createInventoryWarehouseRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/warehouses',
    authenticationMiddleware,
    requirePermission('inventory_warehouse.manage'),
    requireBuildingAccess('buildingId'),
    createWarehouseHandler,
  );

  router.get(
    '/buildings/:buildingId/warehouses',
    authenticationMiddleware,
    requirePermission('inventory_warehouse.read'),
    requireBuildingAccess('buildingId'),
    listBuildingWarehousesHandler,
  );

  router.get(
    '/clients/:clientId/warehouses',
    authenticationMiddleware,
    requirePermission('inventory_warehouse.read'),
    listClientWarehousesHandler,
  );

  router.get(
    '/warehouses/:id',
    authenticationMiddleware,
    requirePermission('inventory_warehouse.read'),
    getWarehouseHandler,
  );

  router.patch(
    '/warehouses/:id',
    authenticationMiddleware,
    requirePermission('inventory_warehouse.manage'),
    updateWarehouseHandler,
  );

  router.patch(
    '/warehouses/:id/status',
    authenticationMiddleware,
    requirePermission('inventory_warehouse.manage'),
    updateWarehouseStatusHandler,
  );

  return router;
}
