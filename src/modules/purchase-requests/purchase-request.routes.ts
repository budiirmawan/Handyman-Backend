import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  cancelPurchaseRequestHandler,
  createPurchaseRequestHandler,
  getPurchaseRequestHandler,
  listBuildingPurchaseRequestsHandler,
  updatePurchaseRequestHandler,
} from './purchase-request.controller';

/**
 * BE-17A — Purchase Request endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`purchase_request.read`):
 *   GET  /buildings/:buildingId/purchase-requests   (?status= & ?requestType= & ?requesterUserId= & ?priority=)
 *   GET  /purchase-requests/:id
 * Management (`purchase_request.manage`):
 *   POST   /buildings/:buildingId/purchase-requests
 *   PATCH  /purchase-requests/:id
 *   POST   /purchase-requests/:id/cancel
 *
 * Building-nested routes pass through `requireBuildingAccess('buildingId')`;
 * the `/purchase-requests/:id` routes enforce the same rule in the controller
 * after resolving the record's Building — so Purchase Request administration
 * inherits BE-02 isolation rather than opening a side channel around it.
 *
 * No approval, vendor selection, purchase order, receiving, or payment
 * endpoints are exposed here (later BE-17 PARTs own those domains).
 */
export function createPurchaseRequestRouter(): Router {
  const router = Router();

  router.post(
    '/buildings/:buildingId/purchase-requests',
    authenticationMiddleware,
    requirePermission('purchase_request.manage'),
    requireBuildingAccess('buildingId'),
    createPurchaseRequestHandler,
  );
  router.get(
    '/buildings/:buildingId/purchase-requests',
    authenticationMiddleware,
    requirePermission('purchase_request.read'),
    requireBuildingAccess('buildingId'),
    listBuildingPurchaseRequestsHandler,
  );
  router.get(
    '/purchase-requests/:id',
    authenticationMiddleware,
    requirePermission('purchase_request.read'),
    getPurchaseRequestHandler,
  );
  router.patch(
    '/purchase-requests/:id',
    authenticationMiddleware,
    requirePermission('purchase_request.manage'),
    updatePurchaseRequestHandler,
  );
  router.post(
    '/purchase-requests/:id/cancel',
    authenticationMiddleware,
    requirePermission('purchase_request.manage'),
    cancelPurchaseRequestHandler,
  );

  return router;
}
