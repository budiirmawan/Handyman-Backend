/**
 * CR-HM-06 PART 02 — Handyman quotation commercial snapshot line types
 * (FROZEN F4/F5). Lines are immutable per-version commercial facts:
 * LABOR vs MATERIAL separation; quantity/UOM + reference vs final
 * amounts; lineTotal is SERVER-calculated only; one currency per
 * version; NO tax/discount ever; NO CR-HM-12 pricing modes/rules; a
 * source item may be stored for provenance ONLY (it never re-prices
 * an immutable line and inventory is never mutated from here).
 */

import type { HandymanTaxPriceBasis } from './handyman-quotation-price-basis';

export const HANDYMAN_QUOTATION_LINE_TYPES = ['LABOR', 'MATERIAL'] as const;
export type HandymanQuotationLineType =
  (typeof HANDYMAN_QUOTATION_LINE_TYPES)[number];

/**
 * CR-HM-MANUAL-QUOTATION-01 PART 03A — line origin provenance (0489).
 * `CATALOG` is the pre-existing lane (a governed catalog-anchored request);
 * `MANUAL_ONE_TIME` marks an operator-authored one-time line, which is the ONLY
 * origin a manual-origin (unlisted-intake) request may carry and is lawful on a
 * catalog request only when the pricing authority already recorded a
 * MANUAL_REVIEW resolution for it.
 */
export const HANDYMAN_QUOTATION_LINE_ORIGIN_KINDS = [
  'CATALOG',
  'MANUAL_ONE_TIME',
] as const;
export type HandymanQuotationLineOriginKind =
  (typeof HANDYMAN_QUOTATION_LINE_ORIGIN_KINDS)[number];

export const HANDYMAN_QUOTATION_CURRENCIES = [
  'IDR',
  'USD',
  'SGD',
  'MYR',
  'AUD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
] as const;
export type HandymanQuotationCurrency =
  (typeof HANDYMAN_QUOTATION_CURRENCIES)[number];

/** Full line database record (immutable snapshot). */
export type HandymanQuotationLineRecord = {
  id: string;
  quotationVersionId: string;
  lineType: HandymanQuotationLineType;
  description: string;
  quantity: number;
  /** units_of_measure master reference (never a free-text uom). */
  uomId: string;
  /** Governed price-catalog snapshot at line creation (may be null). */
  referenceUnitAmount: number | null;
  /** The bounded commercial fact being quoted (operator-authored). */
  finalQuotedUnitAmount: number;
  /** SERVER-calculated: ROUND(quantity * finalQuotedUnitAmount, 2). */
  lineTotal: number;
  currency: HandymanQuotationCurrency;
  /** MATERIAL provenance only; never authoritative re-pricing input. */
  sourceItemId: string | null;
  /** Server-derived origin provenance (0489); never a pricing input. */
  originKind: HandymanQuotationLineOriginKind;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Internal service-layer view of the immutable line snapshot (timestamps ISO).
 * Carries provenance and reference-price snapshots for Backend processes;
 * HTTP controllers must serialize an explicit customer allow-list instead
 * of returning this type.
 */
export type HandymanQuotationLineServiceView = Omit<
  HandymanQuotationLineRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string; taxPriceBasis?: HandymanTaxPriceBasis | null };

/**
 * Caller input: the commercial facts ONLY (type, description, quantity,
 * uom, currency, final quoted unit amount, optional MATERIAL source
 * item for provenance). lineTotal/referenceUnitAmount/client/quotation
 * request/customer/building context NEVER enter here — smuggled keys
 * are structurally ignored (no runtime spreading of caller objects).
 */
export type AddHandymanQuotationLineInput = {
  lineType: HandymanQuotationLineType;
  description: string;
  quantity: number;
  uomId: string;
  currency: HandymanQuotationCurrency;
  finalQuotedUnitAmount: number;
  /** Optional at draft creation, mandatory for every line before ISSUE. */
  taxPriceBasis?: HandymanTaxPriceBasis;
  sourceItemId?: string;
  /**
   * Only `MANUAL_ONE_TIME` may be declared by a caller, and only to label one
   * extra line on a catalog request that the pricing authority already marked
   * MANUAL_REVIEW. On a manual-origin request the origin is forced
   * server-side; a `CATALOG` claim there is refused (0489 law).
   */
  originKind?: HandymanQuotationLineOriginKind;
};

/** Fully-resolved row ready for persistence (server-derived). */
export type NewHandymanQuotationLine = {
  quotationVersionId: string;
  lineType: HandymanQuotationLineType;
  description: string;
  quantity: number;
  uomId: string;
  referenceUnitAmount: number | null;
  finalQuotedUnitAmount: number;
  currency: HandymanQuotationCurrency;
  sourceItemId: string | null;
  originKind: HandymanQuotationLineOriginKind;
  createdByUserId: string;
};

/** Bounded derived totals (F4/F5: derived, never persisted). */
export type PublicHandymanQuotationTotals = {
  laborSubtotal: number;
  materialSubtotal: number;
  total: number;
  /** Single version currency (null when the version has no lines). */
  currency: HandymanQuotationCurrency | null;
  lineCount: number;
};
