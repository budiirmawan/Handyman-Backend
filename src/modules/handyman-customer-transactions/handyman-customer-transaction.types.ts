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

/**
 * PART 02 — the closed composition vocabulary. Every posted charge
 * line names EXACTLY how its amount was composed from governed
 * read-only inputs: the customer-approved snapshot alone, or the
 * approved snapshot bounded by a governed quantity mode whose
 * definition lives on the exact CR-HM-12 agreement version.
 */
export const HANDYMAN_CHARGE_COMPOSITION_KINDS = [
  'LABOR_APPROVED_SNAPSHOT',
  'MATERIAL_APPROVED_SNAPSHOT',
  'MATERIAL_SETTLED_USAGE',
  'MATERIAL_APPROVED_QTY',
] as const;

export type HandymanChargeCompositionKind =
  (typeof HANDYMAN_CHARGE_COMPOSITION_KINDS)[number];

export function isHandymanChargeCompositionKind(
  value: string,
): value is HandymanChargeCompositionKind {
  return (HANDYMAN_CHARGE_COMPOSITION_KINDS as readonly string[])
    .includes(value);
}

/**
 * Which authority the composition consumed: the CR-HM-06 approved
 * snapshot alone, or a CR-HM-12 basis fact bound to an exact
 * agreement version. Never a third value — a fee/entitlement fact can
 * never compose a customer charge.
 */
export const HANDYMAN_CHARGE_BASIS_FACT_KINDS = [
  'CR_HM_06_APPROVED_SNAPSHOT',
  'CR_HM_12_BASIS_FACT',
] as const;

export type HandymanChargeBasisFactKind =
  (typeof HANDYMAN_CHARGE_BASIS_FACT_KINDS)[number];

export function isHandymanChargeBasisFactKind(
  value: string,
): value is HandymanChargeBasisFactKind {
  return (HANDYMAN_CHARGE_BASIS_FACT_KINDS as readonly string[])
    .includes(value);
}

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

/**
 * PART 02 — the immutable COMPOSITION ANCHOR of one charge line
 * (governance I11): which governed inputs produced the amount, bound
 * to the exact CR-HM-12 agreement version where one applied. Money
 * crossing this boundary is a canonical decimal string, and the
 * frozen law `amount = ROUND(unitAmount * appliedQty, 2)` holds with
 * `unitAmount` always the CR-HM-06 approved snapshot unit amount.
 */
export type HandymanChargeLineBasisRecord = {
  id: string;
  clientId: string;
  transactionId: string;
  chargeLineId: string;
  quotationVersionId: string;
  quotationLineId: string;
  lineKind: HandymanChargeLineKind;
  compositionKind: HandymanChargeCompositionKind;
  basisFactKind: HandymanChargeBasisFactKind;
  currency: HandymanCustomerTransactionCurrency;
  /** NUMERIC(14,3) canonical decimal string. */
  appliedQty: string;
  /** NUMERIC(18,2) — the approved snapshot unit amount, never re-authored. */
  unitAmount: string;
  /** NUMERIC(18,2) — the composed charge amount. */
  amount: string;
  agreementId: string | null;
  agreementVersionId: string | null;
  agreementVersionNumber: number | null;
  /** No lawful per-row mode selection exists in this PART: always null. */
  laborBasisRowId: string | null;
  /** The CR-HM-12 material basis row that governed, when one applied. */
  materialBasisRowId: string | null;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: string;
  createdAt: string;
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

export type NewHandymanChargeLineBasis = {
  clientId: string;
  transactionId: string;
  chargeLineId: string;
  quotationVersionId: string;
  quotationLineId: string;
  lineKind: HandymanChargeLineKind;
  compositionKind: HandymanChargeCompositionKind;
  basisFactKind: HandymanChargeBasisFactKind;
  currency: HandymanCustomerTransactionCurrency;
  appliedQty: string;
  unitAmount: string;
  amount: string;
  agreementId: string | null;
  agreementVersionId: string | null;
  agreementVersionNumber: number | null;
  laborBasisRowId: string | null;
  materialBasisRowId: string | null;
  idempotencyKey: string;
  actorUserId: string;
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
 * POST_CHARGE_LINE / COMPOSE_CHARGE_LINE input: the quotation line
 * reference + idempotency key ONLY. amount/currency/lineKind/quantity/
 * composition kind/asOf are NOT accepted from the caller — the
 * immutable snapshot plus the governed CR-HM-12/CR-HM-09 inputs are
 * the only amount authority, and the composition instant is
 * server-derived (§4.3, §9.6, B7).
 */
export type PostHandymanChargeLineInput = {
  executionScopeId: string;
  quotationLineId: string;
  idempotencyKey: string;
};

export type ComposeHandymanChargeLineInput = PostHandymanChargeLineInput;

export type HandymanCustomerTransactionCommandResult = {
  transaction: HandymanCustomerTransactionRecord;
  event: HandymanCustomerTransactionEventRecord;
  replayed: boolean;
};

export type HandymanChargeLineCommandResult =
  HandymanCustomerTransactionCommandResult & {
    chargeLine: HandymanChargeLineRecord;
    /** PART 02 — the immutable composition anchor of the charge line. */
    basis: HandymanChargeLineBasisRecord;
  };
