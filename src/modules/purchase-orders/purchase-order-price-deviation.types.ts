import type {
  PriceCatalogCurrency,
  PriceCatalogScopeTier,
} from '../price-catalog-entries';
import type {
  PurchaseOrderCurrency,
  PurchaseOrderStatus,
} from './purchase-order.types';

/**
 * CR-BE-PRICE-01 PART 06 — PO advisory reference-price deviation read model
 * (governance §13.3, API boundary §20).
 *
 * This is a COMPUTED, read-only projection: nothing is persisted, nothing is
 * an authority, and nothing here ever blocks PO creation, approval,
 * acknowledgement, issuance, award logic or settlement behavior. It answers,
 * per PO line, one governed question: "how does the committed unit price
 * compare to the CURRENT applicable reference price authority?" — resolved
 * through the frozen §8 selection semantics as-of request time.
 *
 * The outcome vocabulary deliberately mirrors the PART 02 resolver plus the
 * PART 04 `NOT_REQUESTED` extension for SERVICE lines. AMBIGUOUS is a typed,
 * fail-closed outcome here (never a fabricated price; the resolver has
 * already audited the incident) — unlike the PART 04 write path, this read
 * model persists nothing, so reporting the typed outcome cannot freeze bad
 * evidence into storage.
 */

export const PO_PRICE_DEVIATION_RESOLUTIONS = [
  'MATCHED',
  'NO_REFERENCE_PRICE',
  'UOM_INCOMPATIBLE',
  'CURRENCY_INCOMPATIBLE',
  'AMBIGUOUS',
  'NOT_REQUESTED',
] as const;
export type PurchaseOrderPriceDeviationResolution =
  (typeof PO_PRICE_DEVIATION_RESOLUTIONS)[number];

export const PO_PRICE_DEVIATION_POSITIONS = [
  'ABOVE',
  'BELOW',
  'EQUAL',
] as const;
export type PurchaseOrderPriceDeviationPosition =
  (typeof PO_PRICE_DEVIATION_POSITIONS)[number];

/** Empty-shape helper: every fact field null unless resolution is MATCHED. */
export type PurchaseOrderLinePriceReference = {
  resolution: PurchaseOrderPriceDeviationResolution;
  /** Winning price-authority row; present only when MATCHED. */
  priceEntryId: string | null;
  /** Provenance tier of the winning entry; null unless MATCHED. */
  scopeTier: PriceCatalogScopeTier | null;
  /** Tier provenance flags (mirror PART 04 snapshot vocabulary). */
  scopeVendor: boolean | null;
  scopeBuilding: boolean | null;
  /** Reference unit price per 1 reference UOM, in reference currency. */
  unitPrice: number | null;
  currency: PriceCatalogCurrency | null;
  uomId: string | null;
  /** Effective authority context of the winning entry. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** reference unit price × PO line frozen quantity (null when quantity is). */
  referenceTotal: number | null;
  /** PO unit price − reference unit price (2dp), only when MATCHED. */
  unitVariance: number | null;
  /** PO line amount − reference total (2dp), only when MATCHED + quantity. */
  totalVariance: number | null;
  /** (unitVariance / reference unitPrice) × 100 (2dp), only when MATCHED. */
  variancePercent: number | null;
  position: PurchaseOrderPriceDeviationPosition | null;
};

export type PurchaseOrderPriceDeviationLine = {
  purchaseOrderLineId: string;
  lineNumber: number;
  requestLineType: 'MATERIAL_REQUEST' | 'SERVICE_REQUEST';
  itemId: string | null;
  uomId: string | null;
  /** Frozen quantity snapshot (never recomputed by this read model). */
  quantitySnapshot: number | null;
  /** Committed PO facts, echoed from the immutable line. */
  unitPrice: number;
  lineAmount: number;
  reference: PurchaseOrderLinePriceReference;
};

export type PurchaseOrderPriceDeviation = {
  purchaseOrderId: string;
  poNumber: string;
  purchaseOrderStatus: PurchaseOrderStatus;
  clientId: string;
  buildingId: string;
  vendorId: string;
  currency: PurchaseOrderCurrency;
  /** Request-time as-of instant used for every line resolution. */
  asOf: string;
  /** Constant posture marker: advisory read data, never a gate (§13.3/§13.4). */
  advisoryOnly: true;
  lines: PurchaseOrderPriceDeviationLine[];
};
