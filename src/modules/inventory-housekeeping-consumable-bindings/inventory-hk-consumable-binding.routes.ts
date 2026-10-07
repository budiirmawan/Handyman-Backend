import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  bindConsumableHandler,
  getBindingHandler,
  listBindingsHandler,
  listBuildingBindingsHandler,
  listCleaningAreaBindingsHandler,
  listClientBindingsHandler,
  listItemBindingsHandler,
  listRequirementBindingsHandler,
  listWarehouseBindingsHandler,
  updateBindingHandler,
} from './inventory-hk-consumable-binding.controller';

/**
 * BE-16J — Housekeeping Consumable Binding endpoints.
 *
 * Reuses BE-11J consumable_requirements as operational context, BE-16 stock as authoritative.
 *
 * Management (consumable_readiness.manage):
 *   POST /housekeeping/consumable-requirements/:requirementId/bindings
 *   PATCH /housekeeping/consumable-bindings/:id
 * Reads (consumable_readiness.read):
 *   GET  /housekeeping/consumable-bindings/:id
 *   GET  /housekeeping/consumable-requirements/:requirementId/bindings
 *   GET  /buildings/:buildingId/housekeeping-consumable-bindings
 *   GET  /cleaning-areas/:cleaningAreaId/housekeeping-consumable-bindings
 *   GET  /clients/:clientId/housekeeping-consumable-bindings
 *   GET  /warehouses/:warehouseId/housekeeping-consumable-bindings
 *   GET  /inventory-items/:itemId/housekeeping-consumable-bindings
 *   GET  /housekeeping/consumable-bindings (global filter)
 *
 * Readiness derived from authoritative stock: READY if available >= required, LOW if 0<available<required, NOT_READY if 0 or null, UNKNOWN if inactive.
 */
export function createInventoryHkConsumableBindingRouter(): Router {
  const router = Router();

  router.post(
    '/housekeeping/consumable-requirements/:requirementId/bindings',
    authenticationMiddleware,
    requirePermission('consumable_readiness.manage'),
    bindConsumableHandler,
  );

  router.patch(
    '/housekeeping/consumable-bindings/:id',
    authenticationMiddleware,
    requirePermission('consumable_readiness.manage'),
    updateBindingHandler,
  );

  router.get(
    '/housekeeping/consumable-bindings/:id',
    authenticationMiddleware,
    requirePermission('consumable_readiness.read'),
    getBindingHandler,
  );

  router.get(
    '/housekeeping/consumable-requirements/:requirementId/bindings',
    authenticationMiddleware,
    requirePermission('consumable_readiness.read'),
    listRequirementBindingsHandler,
  );

  router.get(
    '/buildings/:buildingId/housekeeping-consumable-bindings',
    authenticationMiddleware,
    requirePermission('consumable_readiness.read'),
    requireBuildingAccess('buildingId'),
    listBuildingBindingsHandler,
  );

  router.get(
    '/cleaning-areas/:cleaningAreaId/housekeeping-consumable-bindings',
    authenticationMiddleware,
    requirePermission('consumable_readiness.read'),
    listCleaningAreaBindingsHandler,
  );

  router.get(
    '/clients/:clientId/housekeeping-consumable-bindings',
    authenticationMiddleware,
    requirePermission('consumable_readiness.read'),
    listClientBindingsHandler,
  );

  router.get(
    '/warehouses/:warehouseId/housekeeping-consumable-bindings',
    authenticationMiddleware,
    requirePermission('consumable_readiness.read'),
    listWarehouseBindingsHandler,
  );

  router.get(
    '/inventory-items/:itemId/housekeeping-consumable-bindings',
    authenticationMiddleware,
    requirePermission('consumable_readiness.read'),
    listItemBindingsHandler,
  );

  router.get(
    '/housekeeping/consumable-bindings',
    authenticationMiddleware,
    requirePermission('consumable_readiness.read'),
    listBindingsHandler,
  );

  return router;
}
