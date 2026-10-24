/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Parameterized Handyman Service Catalog
 * types.
 *
 * Bounded vocabularies only. Every value that the engine must refuse is a
 * member of one of the frozen lists below; nothing here is free text.
 *
 * The catalog is built ON TOP OF two existing authorities and never
 * replaces them:
 *   - `service_catalog` (0321) — the governed Service MASTER;
 *   - `handyman_service_variants` (0376) — the Handyman Variant child;
 *   - `price_catalog_entries` (0319 + 0325) — the governed PRICE authority
 *     (the price rules here only SELECT a governed price fact; they never
 *     own an amount).
 */

/** Attribute value data types. */
export const HANDYMAN_SERVICE_ATTRIBUTE_DATA_TYPES = [
  'NUMBER',
  'TEXT',
  'ENUM',
  'BOOLEAN',
] as const;
export type HandymanServiceAttributeDataType =
  (typeof HANDYMAN_SERVICE_ATTRIBUTE_DATA_TYPES)[number];

export function isHandymanServiceAttributeDataType(
  value: unknown,
): value is HandymanServiceAttributeDataType {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_ATTRIBUTE_DATA_TYPES as readonly string[]).includes(
      value,
    )
  );
}

/**
 * The governed price BASIS of a job: what one unit of the quoted amount
 * actually counts. `UNIT` = one appliance/unit, `POINT` = one work point,
 * `METER` = one linear meter, `SQM` = one square meter, `VISIT` = one
 * on-site visit.
 */
export const HANDYMAN_SERVICE_PRICE_BASES = [
  'UNIT',
  'POINT',
  'METER',
  'SQM',
  'VISIT',
] as const;
export type HandymanServicePriceBasis =
  (typeof HANDYMAN_SERVICE_PRICE_BASES)[number];

export function isHandymanServicePriceBasis(
  value: unknown,
): value is HandymanServicePriceBasis {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_PRICE_BASES as readonly string[]).includes(value)
  );
}

/**
 * The per-service commercial posture:
 *   FIXED            — a governed price rule resolves the amount directly.
 *   ESTIMATED        — a governed price rule resolves an ESTIMATE; the
 *                      amount may still change after an inspection, so the
 *                      revision + customer-approval lane applies.
 *   INSPECTION_FIRST — the service may never be quoted before an
 *                      inspection; pricing is refused by design.
 */
export const HANDYMAN_SERVICE_PRICING_MODES = [
  'FIXED',
  'ESTIMATED',
  'INSPECTION_FIRST',
] as const;
export type HandymanServicePricingMode =
  (typeof HANDYMAN_SERVICE_PRICING_MODES)[number];

export function isHandymanServicePricingMode(
  value: unknown,
): value is HandymanServicePricingMode {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_PRICING_MODES as readonly string[]).includes(value)
  );
}

/** Access condition of a request item (execution/access fact). */
export const HANDYMAN_SERVICE_ACCESS_CONDITIONS = [
  'STANDARD',
  'DIFFICULT',
  'HIGH_FLOOR',
  'RESTRICTED',
] as const;
export type HandymanServiceAccessCondition =
  (typeof HANDYMAN_SERVICE_ACCESS_CONDITIONS)[number];

export function isHandymanServiceAccessCondition(
  value: unknown,
): value is HandymanServiceAccessCondition {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_ACCESS_CONDITIONS as readonly string[]).includes(value)
  );
}

/** Outcome of one price resolution attempt. */
export const HANDYMAN_SERVICE_QUOTE_OUTCOMES = [
  'PRICED',
  'INSPECTION_REQUIRED',
  'MANUAL_REVIEW',
] as const;
export type HandymanServiceQuoteOutcome =
  (typeof HANDYMAN_SERVICE_QUOTE_OUTCOMES)[number];

export function isHandymanServiceQuoteOutcome(
  value: unknown,
): value is HandymanServiceQuoteOutcome {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_QUOTE_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The bounded reason vocabulary of a resolution. Every non-PRICED outcome
 * names exactly one of these reasons — there is no free-text escape hatch
 * and no way to say "priced somehow".
 */
export const HANDYMAN_SERVICE_RESOLUTION_REASON_CODES = [
  'PRICE_RESOLVED',
  'ATTRIBUTE_UNKNOWN',
  'ATTRIBUTE_MISSING',
  'ATTRIBUTE_VALUE_INVALID',
  'PRICING_MODE_INSPECTION_FIRST',
  'PRICE_RULE_NOT_FOUND',
  'PRICE_RULE_AMBIGUOUS',
  'PRICE_NOT_AVAILABLE',
  'PRICE_CURRENCY_MISMATCH',
  'UNIT_OF_MEASURE_MISSING',
  'COMMERCIAL_PROFILE_MISSING',
  'SERVICE_VARIANT_MISMATCH',
] as const;
export type HandymanServiceResolutionReasonCode =
  (typeof HANDYMAN_SERVICE_RESOLUTION_REASON_CODES)[number];

export function isHandymanServiceResolutionReasonCode(
  value: unknown,
): value is HandymanServiceResolutionReasonCode {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_RESOLUTION_REASON_CODES as readonly string[]).includes(
      value,
    )
  );
}

/** One allowed value of an attribute definition. */
export type HandymanServiceAttributeAllowedValue = {
  code: string;
  label: string;
};

/** Category record. */
export type HandymanServiceCategoryRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Attribute definition record. */
export type HandymanServiceAttributeRecord = {
  id: string;
  clientId: string;
  serviceCatalogId: string;
  code: string;
  name: string;
  description: string | null;
  dataType: HandymanServiceAttributeDataType;
  unit: string | null;
  required: boolean;
  allowFreeValue: boolean;
  allowedValues: HandymanServiceAttributeAllowedValue[];
  sortOrder: number;
  status: 'ACTIVE' | 'INACTIVE';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Configured attribute value of a variant. */
export type HandymanServiceVariantAttributeRecord = {
  id: string;
  clientId: string;
  serviceVariantId: string;
  attributeId: string;
  valueText: string | null;
  valueNumber: number | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Per-service commercial posture record. */
export type HandymanServiceCommercialProfileRecord = {
  id: string;
  clientId: string;
  serviceCatalogId: string;
  pricingMode: HandymanServicePricingMode;
  notes: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Price rule record (a SELECTOR over the existing price authority). */
export type HandymanServicePriceRuleRecord = {
  id: string;
  clientId: string;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  ruleCode: string;
  priceCatalogEntryId: string;
  priceBasis: HandymanServicePriceBasis;
  attributeSelector: Record<string, string>;
  minQuantity: number | null;
  maxQuantity: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Request item record — one service/size/attribute combination. */
export type HandymanServiceRequestItemRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  quantity: number;
  attributeValues: Record<string, string>;
  accessCondition: HandymanServiceAccessCondition;
  status: 'ACTIVE' | 'REMOVED';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Append-only price snapshot / readiness record. */
export type HandymanServiceQuoteResolutionRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  requestItemId: string | null;
  outcome: HandymanServiceQuoteOutcome;
  reasonCode: HandymanServiceResolutionReasonCode;
  reasonDetail: string | null;
  priceRuleId: string | null;
  priceCatalogEntryId: string | null;
  currency: string | null;
  unitAmount: number | null;
  quantity: number | null;
  priceBasis: HandymanServicePriceBasis | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  computedTotal: number | null;
  quotationId: string | null;
  quotationVersionId: string | null;
  quotationLineId: string | null;
  resolvedByUserId: string;
  createdAt: Date;
};

/** Public (ISO-timestamped) projections. */
export type PublicHandymanServiceCategory = Omit<
  HandymanServiceCategoryRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type PublicHandymanServiceAttribute = Omit<
  HandymanServiceAttributeRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type PublicHandymanServiceCommercialProfile = Omit<
  HandymanServiceCommercialProfileRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type PublicHandymanServicePriceRule = Omit<
  HandymanServicePriceRuleRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type PublicHandymanServiceRequestItem = Omit<
  HandymanServiceRequestItemRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type PublicHandymanServiceQuoteResolution = Omit<
  HandymanServiceQuoteResolutionRecord,
  'createdAt'
> & { createdAt: string };
