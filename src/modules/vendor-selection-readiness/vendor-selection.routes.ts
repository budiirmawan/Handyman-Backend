import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createVendorSelectionHandler,
  getVendorSelectionHandler,
  listByPurchaseRequestHandler,
  listByServiceRequestHandler,
  listByVendorHandler,
} from './vendor-selection.controller';

/**
 * BE-17E — Vendor Selection Readiness endpoints, protected by BE-01 RBAC and
 * BE-02 Building isolation (enforced in the controller after resolving the
 * request's / record's Building).
 *
 * Management (`vendor_selection.manage`):
 *   POST /vendor-selections
 * Reads (`vendor_selection.read`):
 *   GET  /vendor-selections/:id
 *   GET  /purchase-requests/:purchaseRequestId/vendor-selections  (?readiness=)
 *   GET  /service-requests/:serviceRequestId/vendor-selections    (?readiness=)
 *   GET  /vendors/:vendorId/vendor-selections                     (?readiness=)
 *
 * No tender / RFQ / bidding, scoring engine, or Purchase Order Readiness is
 * exposed here (BE-17F later).
 */
export function createVendorSelectionRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('vendor_selection.read');
  const manage = requirePermission('vendor_selection.manage');

  router.post('/vendor-selections', auth, manage, createVendorSelectionHandler);
  router.get('/vendor-selections/:id', auth, read, getVendorSelectionHandler);
  router.get(
    '/purchase-requests/:purchaseRequestId/vendor-selections',
    auth,
    read,
    listByPurchaseRequestHandler,
  );
  router.get(
    '/service-requests/:serviceRequestId/vendor-selections',
    auth,
    read,
    listByServiceRequestHandler,
  );
  router.get(
    '/vendors/:vendorId/vendor-selections',
    auth,
    read,
    listByVendorHandler,
  );
  return router;
}
