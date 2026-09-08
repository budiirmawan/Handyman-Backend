import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  cancelServiceRequestHandler,
  createServiceRequestHandler,
  getServiceRequestHandler,
  listByBuildingHandler,
  listByPurchaseRequestHandler,
  updateServiceRequestHandler,
} from './service-request.controller';

/**
 * BE-17C — Service Request endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`service_request.read`):
 *   GET /purchase-requests/:purchaseRequestId/service-requests
 *   GET /buildings/:buildingId/service-requests   (?status= & ?purchaseRequestId= & ?serviceType=)
 *   GET /service-requests/:id
 * Management (`service_request.manage`):
 *   POST   /purchase-requests/:purchaseRequestId/service-requests
 *   PATCH  /service-requests/:id
 *   POST   /service-requests/:id/cancel
 *
 * Building isolation: the building-nested list uses `requireBuildingAccess`;
 * the purchase-request-nested and `:id` routes enforce it in the controller
 * after resolving the relevant Building. No approval, vendor selection, PO
 * readiness, or operational Work Order execution is exposed here (later BE-17
 * PARTs / BE-08 own those).
 */
export function createServiceRequestRouter(): Router {
  const router = Router();

  router.post(
    '/purchase-requests/:purchaseRequestId/service-requests',
    authenticationMiddleware,
    requirePermission('service_request.manage'),
    createServiceRequestHandler,
  );
  router.get(
    '/purchase-requests/:purchaseRequestId/service-requests',
    authenticationMiddleware,
    requirePermission('service_request.read'),
    listByPurchaseRequestHandler,
  );
  router.get(
    '/buildings/:buildingId/service-requests',
    authenticationMiddleware,
    requirePermission('service_request.read'),
    requireBuildingAccess('buildingId'),
    listByBuildingHandler,
  );
  router.get(
    '/service-requests/:id',
    authenticationMiddleware,
    requirePermission('service_request.read'),
    getServiceRequestHandler,
  );
  router.patch(
    '/service-requests/:id',
    authenticationMiddleware,
    requirePermission('service_request.manage'),
    updateServiceRequestHandler,
  );
  router.post(
    '/service-requests/:id/cancel',
    authenticationMiddleware,
    requirePermission('service_request.manage'),
    cancelServiceRequestHandler,
  );

  return router;
}
