import type {
  HandymanQuotationCurrency,
  HandymanQuotationLineType,
} from '../handyman-quotations';

/**
 * CR-HM-13 PART 01 — customer transaction + charge-line foundation
 * types (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §3/§4/§8/§9,
 * §10 row 01).
 *
 * Vocabulary is REUSED, never reinvented:
 * - charge-line kind = the CR-HM-06 quotation line types
 *   (LABOR / MATERIAL) — the closed kind vocabulary (§4.4);
 * - currency = the CR-HM-06 quotation currency list (§6.4 / I8).
 *
 * Money crosses this boundary as a STRING (canonical decimal, the
 * existing repo money convention): no JavaScript float arithmetic ever
 * touches an amount (§4.7 / I7).
 */

/** Charge-line kinds: exactly the immutable quotation line types. */
export type HandymanChargeLineKind = HandymanQuotationLineType;

/** Transaction currency: exactly the frozen quotation currency list. */
export type HandymanCustomerTransactionCurrency = HandymanQuotationCurrency;

export const HANDYMAN_CUSTOMER_TRANSACTION_EVENT_TYPES = [
  'OPEN_TRANSACTION',
  'POST_CHARGE_LINE',
] as const;

export type HandymanCustomerTransactionEventType =
  (typeof HANDYMAN_CUSTOMER_TRANSACTION_EVENT_TYPES)[number];

export function isHandymanCustomerTransactionEventType(
  value: string,
): value is HandymanCustomerTransactionEventType {
  return (
    HANDYMAN_CUSTOMER_TRANSACTION_EVENT_TYPES as readonly string[]
  ).includes(value);
}

/**
 * The transaction anchor: exactly ONE per CR-HM-06 Execution Scope
 * (§4.2 / I9). Immutable fact — client/scope/approved-version/currency
 * are server-derived and never rewritten.
 */
export type HandymanCustomerTransactionRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  /** The scope's immutable approved quotation version (server-derived). */
  quotationVersionId: string;
  currency: HandymanCustomerTransactionCurrency;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * An immutable posted charge line. `amount`/`lineKind`/`currency` are
 * the immutable quotation snapshot line's facts — never caller input
 * (§4.3). LABOR and MATERIAL stay separate rows: no merged amount and
 * no combined total exists here (§4.5 / I13).
 */
export type HandymanChargeLineRecord = {
  id: string;
  clientId: string;
  transactionId: string;
  quotationLineId: string;
  lineKind: HandymanChargeLineKind;
  currency: HandymanCustomerTransactionCurrency;
  /** NUMERIC(18,2) canonical decimal string. */
  amount: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type HandymanCustomerTransactionEventRecord = {
  id: string;
  clientId: string;
  transactionId: string;
  chargeLineId: string | null;
  eventType: HandymanCustomerTransactionEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: string;
  createdAt: string;
};

/* ---- Persistence inputs (server-derived fields ONLY) ------------ */

export type NewHandymanCustomerTransaction = {
  clientId: string;
  executionScopeId: string;
  quotationVersionId: string;
  currency: HandymanCustomerTransactionCurrency;
  createdByUserId: string;
};

export type NewHandymanChargeLine = {
  clientId: string;
  transactionId: string;
  quotationLineId: string;
  lineKind: HandymanChargeLineKind;
  currency: HandymanCustomerTransactionCurrency;
  amount: string;
  createdByUserId: string;
};

export type NewHandymanCustomerTransactionEvent = {
  clientId: string;
  transactionId: string;
  chargeLineId: string | null;
  eventType: HandymanCustomerTransactionEventType;
  idempotencyKey: string;
  actorUserId: string;
};

/* ---- Caller inputs (references ONLY — no amounts) --------------- */

/**
 * OPEN_TRANSACTION input: the execution scope reference + idempotency
 * key ONLY. clientId/currency/quotationVersion/amount NEVER enter here
 * — smuggled keys are structurally ignored (no runtime spreading of
 * caller objects).
 */
export type OpenHandymanCustomerTransactionInput = {
  executionScopeId: string;
  idempotencyKey: string;
};

/**
 * POST_CHARGE_LINE input: the quotation line reference + idempotency
 * key ONLY. amount/currency/lineKind/status are NOT accepted from the
 * caller — the immutable snapshot is the only amount authority (§4.3).
 */
export type PostHandymanChargeLineInput = {
  executionScopeId: string;
  quotationLineId: string;
  idempotencyKey: string;
};

export type HandymanCustomerTransactionCommandResult = {
  transaction: HandymanCustomerTransactionRecord;
  event: HandymanCustomerTransactionEventRecord;
  replayed: boolean;
};

export type HandymanChargeLineCommandResult =
  HandymanCustomerTransactionCommandResult & {
    chargeLine: HandymanChargeLineRecord;
  };
