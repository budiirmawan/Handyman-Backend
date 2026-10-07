import type {
  PriceCatalogCurrency,
  PublicPriceCatalogEntry,
} from './price-catalog-entry.types';

/**
 * CR-BE-PRICE-01 PART 02 — Material Price + UOM/Scope Selection types.
 *
 * The resolver answers one governed question (governance §8): for an item,
 * a required UOM, a currency, a Building, an optional Vendor, and an as-of
 * timestamp T, which ACTIVE price authority row applies — and when none
 * applies, exactly which fail-closed reason holds. Outcomes are typed and
 * total: the resolver never returns a bare null and never guesses.
 *
 * Deliberately excluded here (unchanged PART 01 / governance non-goals):
 * SERVICE prices, UOM conversion, FX, RFQ comparison integration, deviation
 * overrides, PO/commitment behavior, schedulers, and backfill.
 */

export const PRICE_CATALOG_LOOKUP_RESOLUTIONS = [
  'MATCHED',
  'NO_REFERENCE_PRICE',
  'UOM_INCOMPATIBLE',
  'CURRENCY_INCOMPATIBLE',
  'AMBIGUOUS',
] as const;
export type PriceCatalogLookupResolution =
  (typeof PRICE_CATALOG_LOOKUP_RESOLUTIONS)[number];

export const PRICE_CATALOG_SCOPE_TIERS = [
  'VENDOR_BUILDING',
  'VENDOR',
  'BUILDING',
  'CLIENT_WIDE',
] as const;
export type PriceCatalogScopeTier = (typeof PRICE_CATALOG_SCOPE_TIERS)[number];

export type PriceCatalogLookupInput = {
  /** Scope anchor: the Building the price would be used at. Required. */
  buildingId: string;
  /** Optional vendor context; when absent only non-vendor tiers apply. */
  vendorId?: string | null;
  /** Exact-match currency only; no FX exists or is inferred. */
  currency: PriceCatalogCurrency;
  /** ISO-8601 as-of timestamp T (half-open window selection). */
  asOf: string;
} & (
  | {
      sourceMode: 'MATERIAL';
      itemId: string;
      /** Exact-match UOM only; no conversion exists or is inferred. */
      uomId: string;
    }
  | {
      sourceMode: 'SERVICE';
      /** Governed service_catalog identity (no UOM, no quantity). */
      serviceId: string;
    }
);

export type PriceCatalogLookupResult = {
  resolution: PriceCatalogLookupResolution;
  /** Client derived from the Building context (never taken from the caller). */
  clientId: string;
  buildingId: string;
  vendorId: string | null;
  sourceMode: 'MATERIAL' | 'SERVICE';
  itemId: string | null;
  uomId: string | null;
  serviceId: string | null;
  currency: PriceCatalogCurrency;
  asOf: string;
  /** Provenance tier of the winning entry; present only when MATCHED. */
  scopeTier: PriceCatalogScopeTier | null;
  /** Full authority snapshot of the winning entry; present only when MATCHED. */
  entry: PublicPriceCatalogEntry | null;
};
