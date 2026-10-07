/**
 * R11 PART 03B — Purchase Order Line Register read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint, no route, no
 * controller, no permission vocabulary). Prepared for the Reporting track:
 * the PURCHASE_ORDER_REGISTER adapter (R11 PART 03C, a later PART) will
 * consume this index for its LINE view behind the EXISTING
 * `purchase_order.read`, and the purchase-orders module's own public reads
 * for its HEADER view. Never consumed by operational write flows.
 *
 * The purchase-orders module stays the sole purchase-order authority —
 * this is a bounded SET-BASED read model over its persisted LINE facts
 * (cross-PO in one query, which the per-PO public line read deliberately
 * is not), with the parent header joined read-only for context. It creates
 * no header read model, no lifecycle, no monetary arithmetic and no
 * enrichment from RFQ, price-catalog, receiving, invoice, SPK or
 * work-order drill authorities.
 *
 * `purchaseOrderLineRegisterRepository` is exported for module-internal
 * and test use following the receiving-register precedent; Reporting
 * consumes ONLY the governed service functions below, never the
 * repository.
 */
export { purchaseOrderLineRegisterRepository } from './purchase-order-line-register.repository';
export {
  getPurchaseOrderLineRegister,
  parsePurchaseOrderLineRegisterQuery,
  purchaseOrderLineRegisterService,
} from './purchase-order-line-register.service';
export type {
  PublicPurchaseOrderLineRegister,
  PublicPurchaseOrderLineRegisterRow,
  PurchaseOrderLineRegisterFilters,
} from './purchase-order-line-register.types';
