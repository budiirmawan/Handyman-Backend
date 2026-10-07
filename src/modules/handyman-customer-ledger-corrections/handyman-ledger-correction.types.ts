/**
 * CR-HM-13 PART 05 — refund / reversal / adjustment types (FROZEN
 * governance `CR-HM-13_START_GOVERNANCE.md` §7/§8/§9, §10 row 05,
 * §13 row 05).
 *
 * Corrections are FORWARD-ONLY FACTS: history is never rewritten, and
 * the three kinds are never collapsed. Each fact carries its own
 * timestamp, actor and bounded reason, and is bound to the exact prior
 * fact (or transaction/line) it corrects.
 *
 * Money crosses this boundary as a canonical decimal STRING
 * (`NNN.NN`, at most 2 decimals) and is compared in integer cents — no
 * JavaScript float arithmetic ever touches an amount (§4.7 / I7).
 */

export const HANDYMAN_LEDGER_CORRECTION_KINDS = [
  'REFUND',
  'REVERSAL',
  'ADJUSTMENT',
] as const;

export type HandymanLedgerCorrectionKind =
  (typeof HANDYMAN_LEDGER_CORRECTION_KINDS)[number];

export function isHandymanLedgerCorrectionKind(
  value: string,
): value is HandymanLedgerCorrectionKind {
  return (HANDYMAN_LEDGER_CORRECTION_KINDS as readonly string[])
    .includes(value);
}

export const HANDYMAN_LEDGER_CORRECTION_SOURCE_KINDS = [
  'PAYMENT',
  'ALLOCATION',
  'CHARGE_LINE',
  'TRANSACTION',
] as const;

export type HandymanLedgerCorrectionSourceKind =
  (typeof HANDYMAN_LEDGER_CORRECTION_SOURCE_KINDS)[number];

export function isHandymanLedgerCorrectionSourceKind(
  value: string,
): value is HandymanLedgerCorrectionSourceKind {
  return (HANDYMAN_LEDGER_CORRECTION_SOURCE_KINDS as readonly string[])
    .includes(value);
}

export type HandymanLedgerCorrectionRecord = {
  id: string;
  clientId: string;
  transactionId: string;
  correctionKind: HandymanLedgerCorrectionKind;
  sourceKind: HandymanLedgerCorrectionSourceKind;
  sourcePaymentId: string | null;
  sourceAllocationId: string | null;
  sourceChargeLineId: string | null;
  currency: string;
  /** NUMERIC(18,2) canonical decimal string; always > 0. */
  amount: string;
  reason: string;
  correctedByUserId: string;
  idempotencyKey: string;
  occurredAt: string;
  createdAt: string;
};

export type NewHandymanLedgerCorrection = {
  clientId: string;
  transactionId: string;
  correctionKind: HandymanLedgerCorrectionKind;
  sourceKind: HandymanLedgerCorrectionSourceKind;
  sourcePaymentId: string | null;
  sourceAllocationId: string | null;
  sourceChargeLineId: string | null;
  currency: string;
  amount: string;
  reason: string;
  correctedByUserId: string;
  idempotencyKey: string;
};

/* ---- Caller inputs (references + bounded reason ONLY) ------------ */
/*
 * Amount is a caller decision (how much to refund / the delta magnitude
 * / — for a reversal — nothing at all, since the source fact's amount
 * IS the amount), but it is validated and then re-proved against the
 * ledger by the domain service and again by the database guard.
 * Status/currency/client/source ids beyond the declared source are NOT
 * accepted from the caller.
 */

export type RefundHandymanCustomerPaymentInput = {
  executionScopeId: string;
  paymentId: string;
  amount: string;
  reason: string;
  idempotencyKey: string;
};

export type ReverseHandymanAllocationInput = {
  executionScopeId: string;
  allocationId: string;
  reason: string;
  idempotencyKey: string;
};

export type ReverseHandymanPaymentInput = {
  executionScopeId: string;
  paymentId: string;
  reason: string;
  idempotencyKey: string;
};

export type AdjustHandymanCustomerLedgerInput = {
  executionScopeId: string;
  /** A charge line (line-scoped delta) or omitted (transaction scope). */
  chargeLineId?: string | null;
  amount: string;
  reason: string;
  idempotencyKey: string;
};

export type HandymanLedgerCorrectionCommandResult = {
  correction: HandymanLedgerCorrectionRecord;
  replayed: boolean;
};

/**
 * DERIVED net view over posted facts (§7.4: downstream consumers must
 * see net, never gross-only). Nothing here is stored, so it can never
 * disagree with the ledger.
 */
export type HandymanLedgerCorrectionSummary = {
  transactionId: string;
  currency: string;
  payments: {
    paymentId: string;
    status: string;
    amount: string;
    allocated: string;
    applied: string;
    refunded: string;
    refundable: string;
    reversed: boolean;
  }[];
  chargeLines: {
    chargeLineId: string;
    lineKind: 'LABOR' | 'MATERIAL';
    amount: string;
    allocated: string;
    adjusted: string;
  }[];
  totals: {
    refunded: string;
    reversedAllocations: string;
    reversedPayments: string;
    adjusted: string;
  };
};
