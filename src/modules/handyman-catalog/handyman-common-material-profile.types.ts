import type {
  PriceCatalogCurrency,
  PriceCatalogScopeTier,
} from '../price-catalog-entries';

/**
 * CR-HM-02 PART 02 — Handyman Common Material Profile types.
 *
 * Bounded discovery association (migration 0377): service_catalog master →
 * optional Handyman variant (0376) → common material profile → existing
 * inventory item/SKU master (0166). The inventory item stays the
 * authoritative material master; the price catalog stays the reference-price
 * authority — reference price is composed at read time through the existing
 * price-catalog lookup seam and is NEVER persisted/copied into this profile
 * (there are deliberately no price columns; Reference Price != Quotation !=
 * Final Charge; and no Handyman pricing authority exists).
 *
 * `commonality` / `customerMaterialOption` vocabulary is a NEW Handyman-owned
 * governed vocabulary named by the frozen CR-HM-02 START GOVERNANCE (the
 * concept exists in the frozen chain; no pre-existing authority enum).
 *
 * This profile is never an inventory reservation, issue, stock mutation,
 * purchase, or FM workflow behavior.
 */

export const HANDYMAN_MATERIAL_COMMONALITIES = [
  'COMMON',
  'OCCASIONAL',
  'RARE',
] as const;
export type HandymanMaterialCommonality =
  (typeof HANDYMAN_MATERIAL_COMMONALITIES)[number];

export function isHandymanMaterialCommonality(
  value: unknown,
): value is HandymanMaterialCommonality {
  return (
    typeof value === 'string' &&
    (HANDYMAN_MATERIAL_COMMONALITIES as readonly string[]).includes(value)
  );
}

export const HANDYMAN_CUSTOMER_MATERIAL_OPTIONS = [
  'PROVIDER_SUPPLIED',
  'CUSTOMER_SUPPLIED',
  'CUSTOMER_CHOICE',
] as const;
export type HandymanCustomerMaterialOption =
  (typeof HANDYMAN_CUSTOMER_MATERIAL_OPTIONS)[number];

export function isHandymanCustomerMaterialOption(
  value: unknown,
): value is HandymanCustomerMaterialOption {
  return (
    typeof value === 'string' &&
    (HANDYMAN_CUSTOMER_MATERIAL_OPTIONS as readonly string[]).includes(value)
  );
}

export const HANDYMAN_COMMON_MATERIAL_PROFILE_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HandymanCommonMaterialProfileStatus =
  (typeof HANDYMAN_COMMON_MATERIAL_PROFILE_STATUSES)[number];

export function isHandymanCommonMaterialProfileStatus(
  value: unknown,
): value is HandymanCommonMaterialProfileStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_COMMON_MATERIAL_PROFILE_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/** Full database record. */
export type HandymanCommonMaterialProfileRecord = {
  id: string;
  /** Tenant-isolation root, derived from the parent service entry. */
  clientId: string;
  /** Parent master service reference (`service_catalog.id`). */
  serviceCatalogId: string;
  /** Optional Handyman variant (0376); null = service-level profile. */
  serviceVariantId: string | null;
  /** Authoritative material master reference (`inventory_items.id`). */
  inventoryItemId: string;
  specification: string | null;
  compatibility: string | null;
  typicalQuantity: number | null;
  commonality: HandymanMaterialCommonality;
  customerMaterialOption: HandymanCustomerMaterialOption;
  status: HandymanCommonMaterialProfileStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation. */
export type PublicHandymanCommonMaterialProfile = Omit<
  HandymanCommonMaterialProfileRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

/** Server-side creation input; `clientId` is derived, never supplied. */
export type CreateHandymanCommonMaterialProfileInput = {
  serviceCatalogId: string;
  serviceVariantId?: string;
  inventoryItemId: string;
  specification?: string;
  compatibility?: string;
  typicalQuantity?: number;
  commonality: HandymanMaterialCommonality;
  customerMaterialOption: HandymanCustomerMaterialOption;
};

/** Fully-resolved data ready for persistence. */
export type NewHandymanCommonMaterialProfile = {
  clientId: string;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  inventoryItemId: string;
  specification: string | null;
  compatibility: string | null;
  typicalQuantity: number | null;
  commonality: HandymanMaterialCommonality;
  customerMaterialOption: HandymanCustomerMaterialOption;
  createdByUserId: string;
};

/** List filters for the scoped read foundation (Client scope mandatory). */
export type HandymanCommonMaterialProfileFilters = {
  clientId: string;
  serviceCatalogId?: string;
  serviceVariantId?: string;
  status?: HandymanCommonMaterialProfileStatus;
};

/**
 * Context for composing a reference-price view through the existing
 * price-catalog lookup seam (its governed inputs: Building scope anchor +
 * exact currency + as-of timestamp).
 */
export type HandymanMaterialReferencePriceContext = {
  buildingId: string;
  currency: PriceCatalogCurrency;
  asOf?: string;
};

/** Bounded reference-price view (snapshot fields, never persisted here). */
export type HandymanMaterialReferencePrice = {
  unitPrice: number;
  currency: PriceCatalogCurrency;
  effectiveFrom: string;
  effectiveTo: string | null;
  scopeTier: PriceCatalogScopeTier;
};

/**
 * Payment-adjacent nothing: the catalogue entry with its reference price
 * composed at read time — null whenever the governed lookup does not
 * resolve an applicable material price (fail-closed; never guessed).
 */
export type HandymanCommonMaterialProfileCatalogEntry =
  PublicHandymanCommonMaterialProfile & {
    referencePrice: HandymanMaterialReferencePrice | null;
  };
