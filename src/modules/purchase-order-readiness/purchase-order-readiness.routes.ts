import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createPOReadinessHandler,
  getPOReadinessHandler,
  listByBuildingHandler,
  listByPurchaseRequestHandler,
  listByServiceRequestHandler,
  listByVendorHandler,
  updatePOReadinessHandler,
} from './purchase-order-readiness.controller';

/**
 * BE-17F — Purchase Order Readiness endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the controller after resolving the
 * request's / record's Building).
 *
 * Management (`po_readiness.manage`):
 *   POST  /po-readiness
 *   PATCH /po-readiness/:id
 * Reads (`po_readiness.read`):
 *   GET /po-readiness/:id
 *   GET /buildings/:buildingId/po-readiness          (?readiness=)
 *   GET /purchase-requests/:purchaseRequestId/po-readiness (?readiness=)
 *   GET /service-requests/:serviceRequestId/po-readiness   (?readiness=)
 *   GET /vendors/:vendorId/po-readiness              (?readiness=)
 *
 * PO readiness only — no Purchase Order / ERP, invoice, payment, tax,
 * accounting, 3-way matching, or Receiving (BE-17G later).
 */
export function createPOReadinessRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('po_readiness.read');
  const manage = requirePermission('po_readiness.manage');

  router.post('/po-readiness', auth, manage, createPOReadinessHandler);
  router.patch('/po-readiness/:id', auth, manage, updatePOReadinessHandler);
  router.get('/po-readiness/:id', auth, read, getPOReadinessHandler);
  router.get('/buildings/:buildingId/po-readiness', auth, read, listByBuildingHandler);
  router.get(
    '/purchase-requests/:purchaseRequestId/po-readiness',
    auth,
    read,
    listByPurchaseRequestHandler,
  );
  router.get(
    '/service-requests/:serviceRequestId/po-readiness',
    auth,
    read,
    listByServiceRequestHandler,
  );
  router.get('/vendors/:vendorId/po-readiness', auth, read, listByVendorHandler);
  return router;
}
