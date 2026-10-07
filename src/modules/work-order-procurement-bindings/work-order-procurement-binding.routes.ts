import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  bindWorkContractHandler,
  createBindingHandler,
  getBindingHandler,
  linkReceivingHandler,
  listByWorkOrderHandler,
  resolveReadinessHandler,
} from './work-order-procurement-binding.controller';

/**
 * BE-17H — Work Order Procurement Binding endpoints, protected by BE-01 RBAC
 * and BE-02 Building isolation (enforced in the controller after resolving the
 * Work Order's / binding's Building).
 *
 * Management (`wo_procurement.manage`):
 *   POST /work-order-procurement-bindings
 *   POST /work-order-procurement-bindings/:id/resolve-readiness
 *   POST /work-order-procurement-bindings/:id/link-receiving
 *   POST /work-order-procurement-bindings/:id/bind-work-contract
 *        (CR-BE-R2P-01 PART 05 — binds the ACTIVE SPK, deriving PO/Vendor
 *         from it; extends this binding row rather than creating a second
 *         SPK ↔ WO binding domain)
 * Reads (`wo_procurement.read`):
 *   GET /work-order-procurement-bindings/:id
 *   GET /work-orders/:workOrderId/procurement-bindings
 *
 * No separate Work Order procurement engine, no invoice/payment/tax/accounting.
 */
export function createWOProcurementBindingRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('wo_procurement.read');
  const manage = requirePermission('wo_procurement.manage');

  router.post(
    '/work-order-procurement-bindings',
    auth,
    manage,
    createBindingHandler,
  );
  router.post(
    '/work-order-procurement-bindings/:id/resolve-readiness',
    auth,
    manage,
    resolveReadinessHandler,
  );
  router.post(
    '/work-order-procurement-bindings/:id/link-receiving',
    auth,
    manage,
    linkReceivingHandler,
  );
  // CR-BE-R2P-01 PART 05 — SPK → PO / Vendor / Work Order chain.
  router.post(
    '/work-order-procurement-bindings/:id/bind-work-contract',
    auth,
    manage,
    bindWorkContractHandler,
  );
  router.get(
    '/work-order-procurement-bindings/:id',
    auth,
    read,
    getBindingHandler,
  );
  router.get(
    '/work-orders/:workOrderId/procurement-bindings',
    auth,
    read,
    listByWorkOrderHandler,
  );
  return router;
}
