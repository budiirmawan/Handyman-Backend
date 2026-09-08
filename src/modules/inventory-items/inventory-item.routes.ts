import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createInventoryItemHandler,
  getInventoryItemHandler,
  listClientInventoryItemsHandler,
  updateInventoryItemHandler,
  updateInventoryItemStatusHandler,
} from './inventory-item.controller';

/**
 * BE-16A — Inventory Item Master endpoints, protected by BE-01 RBAC and BE-02 Client isolation.
 *
 * Reads (`inventory_item.read`):
 *   GET  /clients/:clientId/inventory-items   (?status= & ?itemType= & ?category= & ?search= & ?uomId=)
 *   GET  /inventory-items/:id
 * Management (`inventory_item.manage`):
 *   POST  /clients/:clientId/inventory-items
 *   PATCH /inventory-items/:id
 *   PATCH /inventory-items/:id/status
 *
 * Client isolation is enforced in service via contextAccessService.canAccessClient (user must have
 * at least one building under client). Code uniqueness is client_id + code (same as asset/vendor).
 * UOM reuse: optional FK to units_of_measure, enforced same client + ACTIVE.
 *
 * No stock, movement, procurement, pricing, PO, accounting here — BE-16A only.
 */
export function createInventoryItemRouter(): Router {
  const router = Router();

  router.post(
    '/clients/:clientId/inventory-items',
    authenticationMiddleware,
    requirePermission('inventory_item.manage'),
    createInventoryItemHandler,
  );

  router.get(
    '/clients/:clientId/inventory-items',
    authenticationMiddleware,
    requirePermission('inventory_item.read'),
    listClientInventoryItemsHandler,
  );

  router.get(
    '/inventory-items/:id',
    authenticationMiddleware,
    requirePermission('inventory_item.read'),
    getInventoryItemHandler,
  );

  router.patch(
    '/inventory-items/:id',
    authenticationMiddleware,
    requirePermission('inventory_item.manage'),
    updateInventoryItemHandler,
  );

  router.patch(
    '/inventory-items/:id/status',
    authenticationMiddleware,
    requirePermission('inventory_item.manage'),
    updateInventoryItemStatusHandler,
  );

  return router;
}
