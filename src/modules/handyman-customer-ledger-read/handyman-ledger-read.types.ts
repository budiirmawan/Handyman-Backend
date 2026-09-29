/**
 * CR-HM-13 PART 06 — PUBLISHED READ CONTRACT types (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §7.4/§8/§10/§11.8, §13 row 06).
 *
 * This is the read-only, write-incapable consumption family published
 * for CR-HM-14 (entitlement gating) and CR-HM-17/18 (presentation):
 * governed transaction + charge-line + payment + allocation +
 * correction FACTS, with corrections machine-visible and every figure
 * available as BOTH gross (the immutable posted fact) and net (the
 * correction-netted basis).
 *
 * Laws honoured by every shape below:
 *  - never gross-only (§7.4): net and gross are always published side
 *    by side, so entitlement derivation cannot run on gross figures;
 *  - LABOR and MATERIAL stay separate — never collapsed into one
 *    undifferentiated amount (I13/B7);
 *  - money crosses this boundary as a canonical decimal STRING and is
 *    only ever compared/added in integer cents (I7);
 *  - `authoritativeForEntitlement` is the explicit gate CR-HM-14 must
 *    check (§Handoff). It is true only for the net basis derived from
 *    posted immutable facts with no undecided intake outstanding.
 *
 * ZERO new authority: nothing here can post, allocate, correct, or
 * settle anything — see `handyman-ledger-read.repository.ts`, whose
 * ONLY database access is a SELECT.
 */

import type {
  HandymanChargeCompositionKind,
  HandymanChargeLineKind,
  HandymanCustomerTransactionCurrency,
} from '../handyman-customer-transactions';
import type { HandymanCustomerPaymentStatus }
  from '../handyman-customer-payments';
import type {
  HandymanLedgerCorrectionKind,
  HandymanLedgerCorrectionSourceKind,
} from '../handyman-customer-ledger-corrections';

/** Marker carried by every published shape (contract identity). */
export const HANDYMAN_LEDGER_READ_CONTRACT_VERSION = 'CR-HM-13-PART-06';

/**
 * Frozen, machine-readable reasons a shape is NOT authoritative for
 * entitlement derivation. Fail-closed: an empty list is required for
 * `authoritativeForEntitlement: true`.
 */
export const HANDYMAN_LEDGER_READ_AUTHORITY_DENIALS = [
  /** Nothing was charged yet — there is no net basis to derive from. */
  'NO_POSTED_CHARGE_FACTS',
  /** Channel intake is undecided (a PENDING payment exists): wait. */
  'PROVISIONAL_PAYMENTS_PENDING',
] as const;

export type HandymanLedgerReadAuthorityDenial =
  (typeof HANDYMAN_LEDGER_READ_AUTHORITY_DENIALS)[number];

export type HandymanLedgerReadAuthority = {
  /**
   * TRUE only when the shape is the NET basis derived exclusively from
   * posted, immutable, correction-netted ledger facts and no
   * provisional (PENDING) payment intake remains outstanding.
   */
  authoritativeForEntitlement: boolean;
  /** Empty iff authoritative; never free text. */
  deniedBy: HandymanLedgerReadAuthorityDenial[];
};

/** Whether a status is a decided, money-bearing fact. */
export function isHandymanLedgerReadPaymentAuthoritative(
  status: HandymanCustomerPaymentStatus,
  reversedPayment: string,
): boolean {
  return status === 'CONFIRMED' && reversedPayment === '0.00';
}

/* ---- Facts (gross values ARE the immutable posted facts) --------- */

export type HandymanLedgerReadPayment = {
  paymentId: string;
  status: HandymanCustomerPaymentStatus;
  channel: string;
  currency: HandymanCustomerTransactionCurrency;
  /** The posted payment fact. */
  amount: string;
  receivedAt: string;
  allocated: string;
  reversedAllocations: string;
  /** allocated − reversedAllocations (net applied). */
  applied: string;
  refunded: string;
  reversedPayment: string;
  /** applied − refunded; '0.00' for reversed/rejected facts. */
  netReceived: string;
  /** Per-fact gate: CONFIRMED and not reversed. */
  authoritativeForEntitlement: boolean;
};

export type HandymanLedgerReadChargeLine = {
  chargeLineId: string;
  quotationLineId: string;
  /** LABOR / MATERIAL — never merged (I13). */
  lineKind: HandymanChargeLineKind;
  compositionKind: HandymanChargeCompositionKind | null;
  basisFactKind: string | null;
  currency: HandymanCustomerTransactionCurrency;
  /** The immutable posted charge line amount. */
  amount: string;
  adjusted: string;
  /** amount − adjusted (net, corrections machine-visible). */
  netAmount: string;
  allocated: string;
  reversedAllocations: string;
  /** allocated − reversedAllocations. */
  applied: string;
  /** netAmount − applied. */
  outstanding: string;
};

export type HandymanLedgerReadAllocation = {
  allocationId: string;
  paymentId: string;
  chargeLineId: string;
  lineKind: HandymanChargeLineKind;
  currency: HandymanCustomerTransactionCurrency;
  amount: string;
  occurredAt: string;
  /** A reversed allocation stops counting toward applied (I5). */
  reversed: boolean;
};

export type HandymanLedgerReadCorrection = {
  correctionId: string;
  correctionKind: HandymanLedgerCorrectionKind;
  sourceKind: HandymanLedgerCorrectionSourceKind;
  sourcePaymentId: string | null;
  sourceAllocationId: string | null;
  sourceChargeLineId: string | null;
  currency: HandymanCustomerTransactionCurrency;
  amount: string;
  reason: string;
  correctedByUserId: string;
  occurredAt: string;
};

/* ---- Net-vs-gross totals (both always published) ----------------- */

export type HandymanLedgerReadCorrectionCounts = {
  refunds: number;
  reversals: number;
  adjustments: number;
};

export type HandymanLedgerReadTotals = {
  /** Immutable posted charge total (LABOR + MATERIAL, kept separate). */
  chargedGross: string;
  /** Σ line-scoped adjustments, split by line kind (never smeared). */
  laborGross: string;
  materialGross: string;
  laborAdjusted: string;
  materialAdjusted: string;
  /** Transaction-scoped adjustments (not attributable to one line). */
  adjustedTransactionScope: string;
  adjusted: string;
  /** chargedGross − adjusted. */
  chargedNet: string;
  laborNet: string;
  materialNet: string;
  /** Allocation facts and their reversal effect. */
  allocated: string;
  reversedAllocations: string;
  applied: string;
  /** Received funds: CONFIRMED payments, then reversed, then refunded. */
  receivedGross: string;
  receivedReversed: string;
  receivedNet: string;
  refunded: string;
  /** receivedNet − refunded. */
  netReceived: string;
  /** chargedNet − applied. */
  outstanding: string;
  corrections: HandymanLedgerReadCorrectionCounts;
};

/* ---- Published shapes ------------------------------------------- */

export type HandymanLedgerTransactionRead = {
  contractVersion: typeof HANDYMAN_LEDGER_READ_CONTRACT_VERSION;
  readOnly: true;
  transaction: {
    transactionId: string;
    clientId: string;
    executionScopeId: string;
    quotationVersionId: string;
    currency: HandymanCustomerTransactionCurrency;
    createdAt: string;
  };
  chargeLines: HandymanLedgerReadChargeLine[];
  payments: HandymanLedgerReadPayment[];
  allocations: HandymanLedgerReadAllocation[];
  /** ALL three correction kinds, machine-visible (§7.4). */
  corrections: HandymanLedgerReadCorrection[];
  totals: HandymanLedgerReadTotals;
  authority: HandymanLedgerReadAuthority;
};

/** One ledger's net basis — the shape CR-HM-14 gates on. */
export type HandymanLedgerClientBasisEntry = {
  transactionId: string;
  executionScopeId: string;
  currency: HandymanCustomerTransactionCurrency;
  openedAt: string;
  chargedNet: string;
  laborNet: string;
  materialNet: string;
  adjusted: string;
  applied: string;
  receivedNet: string;
  refunded: string;
  reversedAllocations: string;
  receivedReversed: string;
  netReceived: string;
  outstanding: string;
  corrections: HandymanLedgerReadCorrectionCounts;
  authority: HandymanLedgerReadAuthority;
};

export type ReadHandymanLedgerClientBasisOptions = {
  /** Inclusive lower bound on transaction creation time (ISO-8601). */
  from?: string | null;
  /** Exclusive upper bound (ISO-8601). */
  to?: string | null;
  /** Bounded page size: 1..500, default 200. */
  limit?: number;
};

export type HandymanLedgerClientBasisRead = {
  contractVersion: typeof HANDYMAN_LEDGER_READ_CONTRACT_VERSION;
  readOnly: true;
  clientId: string;
  from: string | null;
  to: string | null;
  limit: number;
  transactions: HandymanLedgerClientBasisEntry[];
  totals: {
    transactionCount: number;
    chargedNet: string;
    laborNet: string;
    materialNet: string;
    adjusted: string;
    applied: string;
    receivedNet: string;
    refunded: string;
    reversedAllocations: string;
    receivedReversed: string;
    netReceived: string;
    outstanding: string;
    corrections: HandymanLedgerReadCorrectionCounts;
  };
  authority: HandymanLedgerReadAuthority & {
    /** Ledgers whose own basis is not authoritative (fail-closed). */
    nonAuthoritativeTransactionIds: string[];
  };
};

/* ---- Read-time bounds (callers pass no money, no status) -------- */

export const HANDYMAN_LEDGER_READ_DEFAULT_LIMIT = 200;
export const HANDYMAN_LEDGER_READ_MAX_LIMIT = 500;
