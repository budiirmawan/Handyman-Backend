import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  cancelMaterialRequestHandler,
  createMaterialRequestHandler,
  getMaterialRequestHandler,
  listByBuildingHandler,
  listByItemHandler,
  listByPurchaseRequestHandler,
  updateMaterialRequestHandler,
} from './material-request.controller';

/**
 * BE-17B — Material Request endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`material_request.read`):
 *   GET /purchase-requests/:purchaseRequestId/material-requests
 *   GET /buildings/:buildingId/material-requests   (?status= & ?purchaseRequestId= & ?itemId=)
 *   GET /items/:itemId/material-requests
 *   GET /material-requests/:id
 * Management (`material_request.manage`):
 *   POST   /purchase-requests/:purchaseRequestId/material-requests
 *   PATCH  /material-requests/:id
 *   POST   /material-requests/:id/cancel
 *
 * Building isolation: the building-nested list uses `requireBuildingAccess`;
 * the purchase-request-nested, item-nested, and `:id` routes enforce it in the
 * controller after resolving the relevant Building. No approval, vendor
 * selection, PO, or receiving logic is exposed here (later BE-17 PARTs own
 * those domains).
 */
export function createMaterialRequestRouter(): Router {
  const router = Router();

  router.post(
    '/purchase-requests/:purchaseRequestId/material-requests',
    authenticationMiddleware,
    requirePermission('material_request.manage'),
    createMaterialRequestHandler,
  );
  router.get(
    '/purchase-requests/:purchaseRequestId/material-requests',
    authenticationMiddleware,
    requirePermission('material_request.read'),
    listByPurchaseRequestHandler,
  );
  router.get(
    '/buildings/:buildingId/material-requests',
    authenticationMiddleware,
    requirePermission('material_request.read'),
    requireBuildingAccess('buildingId'),
    listByBuildingHandler,
  );
  router.get(
    '/items/:itemId/material-requests',
    authenticationMiddleware,
    requirePermission('material_request.read'),
    listByItemHandler,
  );
  router.get(
    '/material-requests/:id',
    authenticationMiddleware,
    requirePermission('material_request.read'),
    getMaterialRequestHandler,
  );
  router.patch(
    '/material-requests/:id',
    authenticationMiddleware,
    requirePermission('material_request.manage'),
    updateMaterialRequestHandler,
  );
  router.post(
    '/material-requests/:id/cancel',
    authenticationMiddleware,
    requirePermission('material_request.manage'),
    cancelMaterialRequestHandler,
  );

  return router;
}
