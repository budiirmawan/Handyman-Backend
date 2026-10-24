/**
 * CR-BE-PRICE-01 PART 01 — Price Authority Foundation types.
 *
 * This module owns governed reference prices only (`price_catalog_entries`,
 * migration `0319`). It does not own RFQ comparison integration, deviation or
 * override execution, PO behavior, commitments, actual costs, UOM conversion,
 * FX, or a service-price lane (governance §4/§6/§12/§13).
 */

export const PRICE_CATALOG_SOURCE_MODES = ['MATERIAL', 'SERVICE'] as const;
export type PriceCatalogSourceMode =
  (typeof PRICE_CATALOG_SOURCE_MODES)[number];

export const PRICE_CATALOG_ENTRY_KINDS = [
  'REFERENCE',
  'VENDOR_CONTRACT',
] as const;
export type PriceCatalogEntryKind =
  (typeof PRICE_CATALOG_ENTRY_KINDS)[number];

export const PRICE_CATALOG_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'INACTIVE',
] as const;
export type PriceCatalogStatus = (typeof PRICE_CATALOG_STATUSES)[number];

export function isPriceCatalogStatus(
  value: unknown,
): value is PriceCatalogStatus {
  return (
    typeof value === 'string' &&
    (PRICE_CATALOG_STATUSES as readonly string[]).includes(value)
  );
}

export const PRICE_CATALOG_SOURCE_TYPES = ['MANUAL'] as const;
export type PriceCatalogSourceType =
  (typeof PRICE_CATALOG_SOURCE_TYPES)[number];

export const PRICE_CATALOG_CURRENCIES = [
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
export type PriceCatalogCurrency = (typeof PRICE_CATALOG_CURRENCIES)[number];

export function isPriceCatalogCurrency(
  value: unknown,
): value is PriceCatalogCurrency {
  return (
    typeof value === 'string' &&
    (PRICE_CATALOG_CURRENCIES as readonly string[]).includes(value)
  );
}

export type PriceCatalogEntryRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  vendorId: string | null;
  sourceMode: PriceCatalogSourceMode;
  entryKind: PriceCatalogEntryKind;
  /** MATERIAL subject (NULL for SERVICE). */
  itemId: string | null;
  /** MATERIAL UOM (NULL for SERVICE). */
  uomId: string | null;
  /**
   * CR-BE-SVC-01 PART 05 — SERVICE subject (NULL for MATERIAL). A governed
   * service identity priced per 1 service in one currency (no UOM/quantity).
   */
  serviceId: string | null;
  /**
   * CR-HM-SERVICE-CATALOG-01 PART 01 — the CATALOGUE PRICE TIER this
   * SERVICE reference price fills. NULL for MATERIAL; '' is the plain
   * service reference price; a non-empty key is shared with the catalogue
   * price rule that consumes the price.
   */
  servicePriceKey: string | null;
  currency: PriceCatalogCurrency;
  unitPrice: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: PriceCatalogStatus;
  activatedAt: Date | null;
  activatedByUserId: string | null;
  deactivatedAt: Date | null;
  deactivatedByUserId: string | null;
  replacedByEntryId: string | null;
  sourceType: PriceCatalogSourceType;
  sourceReference: string | null;
  notes: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPriceCatalogEntry = Omit<
  PriceCatalogEntryRecord,
  | 'idempotencyKey'
  | 'idempotencyFingerprint'
  | 'effectiveFrom'
  | 'effectiveTo'
  | 'activatedAt'
  | 'deactivatedAt'
  | 'approvedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  effectiveFrom: string;
  effectiveTo: string | null;
  activatedAt: string | null;
  deactivatedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewPriceCatalogEntry = {
  clientId: string;
  buildingId: string | null;
  vendorId: string | null;
  sourceMode: PriceCatalogSourceMode;
  entryKind: PriceCatalogEntryKind;
  itemId: string | null;
  uomId: string | null;
  serviceId: string | null;
  servicePriceKey: string | null;
  currency: PriceCatalogCurrency;
  unitPrice: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceReference: string | null;
  notes: string | null;
  approvedByUserId: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
};

export type CreatePriceCatalogEntryInput = {
  clientId: string;
  buildingId?: string | null;
  vendorId?: string | null;
  sourceMode: PriceCatalogSourceMode;
  /** MATERIAL subject (required when sourceMode = MATERIAL). */
  itemId?: string;
  /** MATERIAL UOM (required when sourceMode = MATERIAL). */
  uomId?: string;
  /** SERVICE subject (required when sourceMode = SERVICE). */
  serviceId?: string;
  /**
   * CR-HM-SERVICE-CATALOG-01 PART 01 — the CATALOGUE PRICE TIER this SERVICE
   * reference price fills. '' (the default) is the plain service reference
   * price; a non-empty key names a tier and must equal the catalogue price
   * rule code that consumes it. MATERIAL entries never carry a tier key.
   */
  servicePriceKey?: string;
  currency: PriceCatalogCurrency;
  unitPrice: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
  approvedByUserId?: string | null;
  idempotencyKey: string;
};

export type UpdatePriceCatalogEntryInput = {
  buildingId?: string | null;
  vendorId?: string | null;
  itemId?: string;
  uomId?: string;
  serviceId?: string;
  currency?: PriceCatalogCurrency;
  unitPrice?: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
  approvedByUserId?: string | null;
};

export type ReplacePriceCatalogEntryInput = {
  unitPrice: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceReference?: string | null;
  notes?: string | null;
  approvedByUserId?: string | null;
  idempotencyKey: string;
};

/**
 * PART 05 — governed override/corrective command input (governance §11/§14).
 * Carries the same authority facts as a replacement plus the mandatory,
 * length-checked governance reason. The correction lane is the only command
 * permitted to open a successor window earlier than the predecessor's window
 * start (retroactive correction after `.override`); it never edits the
 * historical row's price/window facts in place.
 */
export type CorrectPriceCatalogEntryInput =
  ReplacePriceCatalogEntryInput & {
    reason: string;
  };

export type PriceCatalogEntryFilters = {
  clientId?: string;
  buildingId?: string;
  itemId?: string;
  serviceId?: string;
  vendorId?: string;
  uomId?: string;
  currency?: PriceCatalogCurrency;
  status?: PriceCatalogStatus;
};
