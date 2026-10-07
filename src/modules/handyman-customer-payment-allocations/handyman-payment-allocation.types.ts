/**
 * CR-HM-13 PART 04 — payment allocation types (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §6/§8/§9, §10 row 04, §13 row 04).
 *
 * An allocation is an APPEND-ONLY FACT binding part (or all) of ONE
 * confirmed payment to ONE immutable charge line. It is never a
 * status: allocated/unallocated amounts are derived projections over
 * these facts, so no authored "PAID" state can exist here (§6.6).
 *
 * Money crosses this boundary as a canonical decimal STRING
 * (`NNN.NN`, at most 2 decimals) and is compared in integer cents —
 * no JavaScript float arithmetic ever touches an amount (§6.4/I7).
 */

export type HandymanPaymentAllocationRecord = {
  id: string;
  clientId: string;
  transactionId: string;
  paymentId: string;
  chargeLineId: string;
  /** The charge line's own kind: LABOR and MATERIAL never merge. */
  lineKind: 'LABOR' | 'MATERIAL';
  currency: string;
  /** NUMERIC(18,2) canonical decimal string; always > 0. */
  amount: string;
  allocatedByUserId: string;
  idempotencyKey: string;
  occurredAt: string;
  createdAt: string;
};

export type NewHandymanPaymentAllocation = {
  clientId: string;
  transactionId: string;
  paymentId: string;
  chargeLineId: string;
  lineKind: 'LABOR' | 'MATERIAL';
  currency: string;
  amount: string;
  allocatedByUserId: string;
  idempotencyKey: string;
};

/**
 * ALLOCATE_PAYMENT input. `amount` is a caller decision (how much of
 * this payment applies to this line) and is therefore validated but
 * never trusted: it must be a canonical positive decimal, and every
 * invariant (payment status, transaction, currency, kind, caps) is
 * re-proved inside the ledger. Status/currency/lineKind/transaction/
 * client are NOT accepted from the caller.
 */
export type AllocateHandymanCustomerPaymentInput = {
  executionScopeId: string;
  paymentId: string;
  chargeLineId: string;
  amount: string;
  idempotencyKey: string;
};

export type HandymanPaymentAllocationCommandResult = {
  allocation: HandymanPaymentAllocationRecord;
  /** Derived at command time, never authored (§6.6). */
  paymentAllocated: string;
  paymentUnallocated: string;
  chargeLineAllocated: string;
  chargeLineOutstanding: string;
  replayed: boolean;
};

/**
 * DERIVED projection over posted facts (§6.6) — never a stored status.
 * `unallocated` is payment amount minus the payment's allocations;
 * `outstanding` is charge-line amount minus the line's allocations.
 */
export type HandymanPaymentAllocationSummary = {
  transactionId: string;
  currency: string;
  payments: {
    paymentId: string;
    status: string;
    amount: string;
    allocated: string;
    unallocated: string;
  }[];
  chargeLines: {
    chargeLineId: string;
    lineKind: 'LABOR' | 'MATERIAL';
    amount: string;
    allocated: string;
    outstanding: string;
  }[];
  totalAllocated: string;
};
