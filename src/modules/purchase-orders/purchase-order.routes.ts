import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  addPurchaseOrderLineHandler,
  getPurchaseOrderLineHandler,
  listPurchaseOrderLinesHandler,
  removePurchaseOrderLineHandler,
  updatePurchaseOrderLineHandler,
} from './purchase-order-line.controller';
import {
  cancelPurchaseOrderHandler,
  createPurchaseOrderHandler,
  getPurchaseOrderAvailableActionsHandler,
  getPurchaseOrderHandler,
  getPurchaseOrderIssueReadinessHandler,
  getPurchaseOrderPriceDeviationHandler,
  issuePurchaseOrderHandler,
  listPurchaseOrdersHandler,
  updatePurchaseOrderHandler,
} from './purchase-order.controller';

/**
 * CR-BE-R2P-01 PART 01 — Purchase Order endpoints.
 *
 * The Purchase Order is the COMMITMENT authority in the R2P chain. BE-17F
 * `purchase_order_readiness` remains the sole READINESS authority and is a
 * hard precondition for committing — this router exposes no readiness
 * evaluation of its own.
 *
 * Management (`purchase_order.manage`):
 *   POST   /purchase-orders            (commit against a READY PO Readiness)
 *   PATCH  /purchase-orders/:id        (DRAFT only)
 *   POST   /purchase-orders/:id/cancel (DRAFT only)
 *
 * Reads (`purchase_order.read`):
 *   GET    /purchase-orders            (?vendorId= & ?buildingId= &
 *                                       ?purchaseRequestId= & ?serviceRequestId= &
 *                                       ?status= & ?poDateFrom= & ?poDateTo=)
 *   GET    /purchase-orders/:id
 *   GET    /purchase-orders/:id/available-actions
 *          (caller-specific; manage permission + existing command authority)
 *
 * PART 02 — PO Lines (commercial commitment over an originating MR/SR line;
 * Material Request remains the single quantity authority):
 *   POST   /purchase-orders/:id/lines          (`purchase_order.manage`, DRAFT only)
 *   GET    /purchase-orders/:id/lines          (`purchase_order.read`)
 *   GET    /purchase-order-lines/:lineId       (`purchase_order.read`)
 *   PATCH  /purchase-order-lines/:lineId       (`purchase_order.manage`, DRAFT only)
 *   DELETE /purchase-order-lines/:lineId       (`purchase_order.manage`, DRAFT only)
 *
 * BE-02 Building isolation is enforced in the service after resolving the
 * readiness / record Building, so these routes inherit BE-02G rather than
 * opening a side channel around it.
 *
 * PART 03 — Issuance & status lifecycle. BE-17F PO Readiness stays the sole
 * readiness authority and a precondition; the issue-readiness endpoint is a
 * read-only projection that reports that verdict, never a second authority:
 *   POST   /purchase-orders/:id/issue            (`purchase_order.manage`, DRAFT only)
 *   GET    /purchase-orders/:id/issue-readiness  (`purchase_order.read`)
 *
 * Deliberately NOT here: SPK / Work Contract (PART 04), SPK↔WO binding
 * (PART 05). No receiving-gate, material-quantity, invoice or payment
 * behavior changes.
 */
export function createPurchaseOrderRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('purchase_order.read');
  const manage = requirePermission('purchase_order.manage');

  router.post('/purchase-orders', auth, manage, createPurchaseOrderHandler);
  router.get('/purchase-orders', auth, read, listPurchaseOrdersHandler);
  router.get('/purchase-orders/:id', auth, read, getPurchaseOrderHandler);
  router.get(
    '/purchase-orders/:id/available-actions',
    auth,
    read,
    getPurchaseOrderAvailableActionsHandler,
  );
  router.patch(
    '/purchase-orders/:id',
    auth,
    manage,
    updatePurchaseOrderHandler,
  );
  router.post(
    '/purchase-orders/:id/cancel',
    auth,
    manage,
    cancelPurchaseOrderHandler,
  );

  // PART 03 — Issuance & status lifecycle.
  router.post(
    '/purchase-orders/:id/issue',
    auth,
    manage,
    issuePurchaseOrderHandler,
  );
  router.get(
    '/purchase-orders/:id/issue-readiness',
    auth,
    read,
    getPurchaseOrderIssueReadinessHandler,
  );

  // CR-BE-PRICE-01 PART 06 — advisory reference-price deviation read model
  // (§13.3/§20). Conjunctive permission: the whole payload is price-authority
  // data, so the route requires BOTH `purchase_order.read` and
  // `price_catalog.read` — a caller lacking either receives 403, never a
  // masked/fast-degraded variant. Warn-only; never an issuance gate.
  const priceCatalogRead = requirePermission('price_catalog.read');
  router.get(
    '/purchase-orders/:id/price-deviation',
    auth,
    read,
    priceCatalogRead,
    getPurchaseOrderPriceDeviationHandler,
  );

  // PART 02 — PO Line & Request Linkage.
  router.post(
    '/purchase-orders/:id/lines',
    auth,
    manage,
    addPurchaseOrderLineHandler,
  );
  router.get(
    '/purchase-orders/:id/lines',
    auth,
    read,
    listPurchaseOrderLinesHandler,
  );
  router.get(
    '/purchase-order-lines/:lineId',
    auth,
    read,
    getPurchaseOrderLineHandler,
  );
  router.patch(
    '/purchase-order-lines/:lineId',
    auth,
    manage,
    updatePurchaseOrderLineHandler,
  );
  router.delete(
    '/purchase-order-lines/:lineId',
    auth,
    manage,
    removePurchaseOrderLineHandler,
  );

  return router;
}
