import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createReceivingHandler,
  finalizeReceivingHandler,
  getReceivingHandler,
  listByBuildingHandler,
  listByPurchaseRequestHandler,
  listByServiceRequestHandler,
  listByVendorHandler,
  updateReceivingHandler,
} from './receiving.controller';

/**
 * BE-17G — Receiving endpoints, protected by BE-01 RBAC and BE-02 Building
 * isolation (enforced in the controller after resolving the request's /
 * record's Building).
 *
 * Management (`receiving.manage`):
 *   POST  /receivings
 *   PATCH /receivings/:id
 *   POST  /receivings/:id/finalize
 * Reads (`receiving.read`):
 *   GET /receivings/:id
 *   GET /buildings/:buildingId/receivings          (?status= & ?receivingType=)
 *   GET /purchase-requests/:purchaseRequestId/receivings
 *   GET /service-requests/:serviceRequestId/receivings
 *   GET /vendors/:vendorId/receivings
 *
 * No invoice, payment, tax, accounting, 3-way matching, or Work Order
 * Procurement Binding (BE-17H later).
 */
export function createReceivingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('receiving.read');
  const manage = requirePermission('receiving.manage');

  router.post('/receivings', auth, manage, createReceivingHandler);
  router.patch('/receivings/:id', auth, manage, updateReceivingHandler);
  router.post('/receivings/:id/finalize', auth, manage, finalizeReceivingHandler);
  router.get('/receivings/:id', auth, read, getReceivingHandler);
  router.get('/buildings/:buildingId/receivings', auth, read, listByBuildingHandler);
  router.get(
    '/purchase-requests/:purchaseRequestId/receivings',
    auth,
    read,
    listByPurchaseRequestHandler,
  );
  router.get(
    '/service-requests/:serviceRequestId/receivings',
    auth,
    read,
    listByServiceRequestHandler,
  );
  router.get('/vendors/:vendorId/receivings', auth, read, listByVendorHandler);
  return router;
}
