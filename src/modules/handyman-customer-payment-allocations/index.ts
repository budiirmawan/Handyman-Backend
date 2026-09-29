/**
 * CR-HM-13 PART 04 — payment allocation exports (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §6/§9, §13 row 04).
 *
 * Bounded surface: allocate part or all of a CONFIRMED payment to ONE
 * immutable charge line (partial allocation is first-class), plus a
 * bounded internal facts read and a DERIVED allocation summary.
 * Payment-bounded and charge-bounded caps, one currency per
 * transaction (no FX), same-transaction binding, and LABOR/MATERIAL
 * separation are enforced in the ledger AND in the database.
 *
 * Still NO refund / reversal / adjustment (PART 05), NO published read
 * contract (PART 06), NO HTTP, NO OpenAPI, NO
 * entitlement/settlement/payout, NO named-provider/gateway runtime.
 */

export {
  allocateHandymanCustomerPayment,
  listHandymanPaymentAllocations,
  summarizeHandymanPaymentAllocations,
} from './handyman-payment-allocation.service';

export { handymanPaymentAllocationRepository }
  from './handyman-payment-allocation.repository';

export {
  handymanPaymentAllocationNotFoundError,
  handymanPaymentAllocationConflictError,
  handymanPaymentAllocationInvalidError,
} from './handyman-payment-allocation.errors';

export type {
  HandymanPaymentAllocationRecord,
  NewHandymanPaymentAllocation,
  AllocateHandymanCustomerPaymentInput,
  HandymanPaymentAllocationCommandResult,
  HandymanPaymentAllocationSummary,
} from './handyman-payment-allocation.types';
