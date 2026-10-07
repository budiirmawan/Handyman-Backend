/**
 * R11 PART 05B — Stock Movement Register read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint, no route, no
 * controller, no permission vocabulary). Prepared for the Reporting track:
 * the STOCK_MOVEMENT_REGISTER adapter (a later R11 PART) will consume this
 * index behind the EXISTING `inventory_stock.read`. Never consumed by
 * operational write flows.
 *
 * The inventory-stock-movements module stays the sole movements authority —
 * this is a bounded SET-BASED read model over its persisted movement facts
 * with the actor-access scope, fail-closed empty-scope behavior, governed
 * strict-calendar-date half-open window and verbatim historical-snapshot
 * semantics that the existing public list read deliberately does not
 * provide. It creates no movement write model, no lifecycle, no
 * current-balance resolution, no monetary arithmetic and no enrichment
 * from warehouse/item display, receiving, work-order-usage, reservation,
 * transfer or adjustment drill authorities. The existing public
 * `listMovements` API is NOT modified by this PART.
 *
 * `stockMovementRegisterRepository` is exported for module-internal and
 * test use following the receiving-register / purchase-order-line-register
 * precedent; Reporting consumes ONLY the governed service functions below,
 * never the repository.
 */
export { stockMovementRegisterRepository } from './stock-movement-register.repository';
export {
  getStockMovementRegister,
  parseStockMovementRegisterQuery,
  stockMovementRegisterRange,
  stockMovementRegisterService,
} from './stock-movement-register.service';
export type {
  PublicStockMovementRegister,
  PublicStockMovementRegisterRow,
  StockMovementRegisterFilters,
} from './stock-movement-register.types';
