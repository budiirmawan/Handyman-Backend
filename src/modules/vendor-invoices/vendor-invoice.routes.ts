import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelVendorInvoiceHandler,
  createVendorInvoiceHandler,
  finalizeVendorInvoiceHandler,
  getVendorInvoiceAvailableActionsHandler,
  getVendorInvoiceConsistencyHandler,
  getVendorInvoiceHandler,
  getVendorInvoiceMatchingHandler,
  getVendorInvoiceTraceHandler,
  getSettlementReadinessHandler,
  listVendorInvoicesHandler,
  recordVendorPaymentHandler,
  updateVendorInvoiceHandler,
  verifyVendorInvoiceHandler,
} from './vendor-invoice.controller';

/**
 * CR-BE-COM-02 PART 01–05 — Vendor Invoice endpoints.
 *
 * Management (`vendor_invoice.manage`):
 *   POST   /vendors/:vendorId/invoices
 *   PATCH  /vendor-invoices/:id
 *   POST   /vendor-invoices/:id/finalize
 *   POST   /vendor-invoices/:id/cancel
 *   POST   /vendor-invoices/:id/verify
 *   POST   /vendor-invoices/:id/payment
 *
 * Reads (`vendor_invoice.read`):
 *   GET    /vendor-invoices
 *   GET    /vendor-invoices/:id
 *   GET    /vendor-invoices/:id/available-actions
 *   GET    /vendor-invoices/:id/matching
 *   GET    /vendor-invoices/:id/settlement-readiness
 *   GET    /vendor-invoices/:id/consistency
 *   GET    /vendor-invoices/:id/trace
 *
 * No bank/payment gateway, AP ledger, GL, tax engine, or settlement.
 */
export function createVendorInvoiceRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('vendor_invoice.read');
  const manage = requirePermission('vendor_invoice.manage');

  router.post(
    '/vendors/:vendorId/invoices',
    auth,
    manage,
    createVendorInvoiceHandler,
  );
  router.get('/vendor-invoices', auth, read, listVendorInvoicesHandler);
  router.get('/vendor-invoices/:id', auth, read, getVendorInvoiceHandler);
  router.get(
    '/vendor-invoices/:id/available-actions',
    auth,
    read,
    getVendorInvoiceAvailableActionsHandler,
  );
  router.patch(
    '/vendor-invoices/:id',
    auth,
    manage,
    updateVendorInvoiceHandler,
  );
  router.post(
    '/vendor-invoices/:id/finalize',
    auth,
    manage,
    finalizeVendorInvoiceHandler,
  );
  router.post(
    '/vendor-invoices/:id/cancel',
    auth,
    manage,
    cancelVendorInvoiceHandler,
  );

  // PART 02: Verification / Matching
  router.post(
    '/vendor-invoices/:id/verify',
    auth,
    manage,
    verifyVendorInvoiceHandler,
  );
  router.get(
    '/vendor-invoices/:id/matching',
    auth,
    read,
    getVendorInvoiceMatchingHandler,
  );

  // PART 03: Payment Status
  router.post(
    '/vendor-invoices/:id/payment',
    auth,
    manage,
    recordVendorPaymentHandler,
  );

  // PART 04: Settlement Readiness
  router.get(
    '/vendor-invoices/:id/settlement-readiness',
    auth,
    read,
    getSettlementReadinessHandler,
  );

  // PART 05: Vendor Consistency + BAST Hard Gate + Trace
  router.get(
    '/vendor-invoices/:id/consistency',
    auth,
    read,
    getVendorInvoiceConsistencyHandler,
  );
  router.get(
    '/vendor-invoices/:id/trace',
    auth,
    read,
    getVendorInvoiceTraceHandler,
  );

  return router;
}
