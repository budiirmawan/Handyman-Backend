import { handymanParameterizedCatalogRepository } from './handyman-parameterized-catalog.repository';
import { serviceCatalogRepository } from '../service-catalog';
import type {
  HandymanServiceAttributeRecord,
  HandymanServicePriceBasis,
  HandymanServicePriceRuleRecord,
  HandymanServiceQuoteOutcome,
  HandymanServiceRequestItemRecord,
  HandymanServiceResolutionReasonCode,
} from './handyman-parameterized-catalog.types';
import { HANDYMAN_STARTER_UOMS } from './handyman-parameterized-catalog.starter';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — the PRICE RESOLUTION engine.
 *
 * This module NEVER computes a price of its own. It resolves, for one
 * request item at one effective date, WHICH governed price fact applies:
 *
 *   attributes (from the request item)
 *     -> the service's attribute definitions (unknown / missing / invalid?)
 *     -> the service's commercial posture (may forbid pricing outright)
 *     -> the service's price rules (selector + quantity band + variant)
 *     -> the EXISTING governed price authority row (`price_catalog_entries`)
 *     -> the quantity UOM of the price basis
 *
 * Fail-closed by construction: when anything is unknown, missing, invalid,
 * ambiguous or simply not priced, the outcome is
 * INSPECTION_REQUIRED or MANUAL_REVIEW — NEVER an amount. There is no
 * default price, no interpolated price and no "best guess" branch.
 */

/** The UOM code each price basis counts in. */
const BASIS_UOM_CODE: Record<HandymanServicePriceBasis, string> =
  HANDYMAN_STARTER_UOMS.reduce(
    (acc, uom) => {
      acc[uom.basis] = uom.code;
      return acc;
    },
    {} as Record<HandymanServicePriceBasis, string>,
  );

/** The outcome of one item's price resolution (before persistence). */
export type HandymanPriceResolutionDraft = {
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
  /** The UOM the quotation line would use (null when unresolvable). */
  uomId: string | null;
};

export type HandymanPriceResolutionContext = {
  clientId: string;
  buildingId: string;
  /** The effective instant of the resolution (price validity anchor). */
  effectiveAt: Date;
};

function notPriced(
  requestItemId: string | null,
  outcome: HandymanServiceQuoteOutcome,
  reasonCode: HandymanServiceResolutionReasonCode,
  reasonDetail: string | null,
): HandymanPriceResolutionDraft {
  return {
    requestItemId,
    outcome,
    reasonCode,
    reasonDetail,
    priceRuleId: null,
    priceCatalogEntryId: null,
    currency: null,
    unitAmount: null,
    quantity: null,
    priceBasis: null,
    effectiveFrom: null,
    effectiveTo: null,
    computedTotal: null,
    uomId: null,
  };
}

function isValidAttributeValue(
  attribute: HandymanServiceAttributeRecord,
  value: string,
): { valid: boolean; detail: string | null } {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    return {
      valid: false,
      detail: `Attribute ${attribute.code} must carry a 1-200 character value.`,
    };
  }
  if (attribute.dataType === 'NUMBER') {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        valid: false,
        detail: `Attribute ${attribute.code} must be a positive number.`,
      };
    }
  }
  if (attribute.dataType === 'BOOLEAN') {
    if (trimmed !== 'true' && trimmed !== 'false') {
      return {
        valid: false,
        detail: `Attribute ${attribute.code} must be "true" or "false".`,
      };
    }
  }
  if (
    attribute.allowedValues.length > 0 &&
    !attribute.allowFreeValue &&
    !attribute.allowedValues.some((allowed) => allowed.code === trimmed)
  ) {
    return {
      valid: false,
      detail: `Attribute ${attribute.code} value "${trimmed}" is not one of the allowed values.`,
    };
  }
  return { valid: true, detail: null };
}

/**
 * Attribute validation of one request item. The order is deliberate:
 * an unknown attribute is reported before a missing one, and both before a
 * value problem, so the recorded reason names the FIRST thing that is
 * wrong.
 */
function validateItemAttributes(
  item: HandymanServiceRequestItemRecord,
  attributes: HandymanServiceAttributeRecord[],
): { reasonCode: HandymanServiceResolutionReasonCode; detail: string } | null {
  const byCode = new Map(attributes.map((a) => [a.code, a]));
  for (const key of Object.keys(item.attributeValues)) {
    if (!byCode.has(key)) {
      return {
        reasonCode: 'ATTRIBUTE_UNKNOWN',
        detail: `Attribute "${key}" is not defined for this service.`,
      };
    }
  }
  for (const attribute of attributes) {
    const raw = item.attributeValues[attribute.code];
    if (raw === undefined || raw === null || raw.trim().length === 0) {
      if (attribute.required) {
        return {
          reasonCode: 'ATTRIBUTE_MISSING',
          detail: `Required attribute "${attribute.code}" is missing.`,
        };
      }
      continue;
    }
    const check = isValidAttributeValue(attribute, raw);
    if (!check.valid) {
      return {
        reasonCode: 'ATTRIBUTE_VALUE_INVALID',
        detail: check.detail ?? `Attribute "${attribute.code}" is invalid.`,
      };
    }
  }
  return null;
}

function ruleMatchesItem(
  rule: HandymanServicePriceRuleRecord,
  item: HandymanServiceRequestItemRecord,
): boolean {
  if (rule.serviceVariantId !== null && rule.serviceVariantId !== item.serviceVariantId) {
    return false;
  }
  for (const [code, expected] of Object.entries(rule.attributeSelector)) {
    const actual = item.attributeValues[code];
    if (actual === undefined || actual.trim() !== expected.trim()) {
      return false;
    }
  }
  if (rule.minQuantity !== null && item.quantity < rule.minQuantity) {
    return false;
  }
  if (rule.maxQuantity !== null && item.quantity > rule.maxQuantity) {
    return false;
  }
  return true;
}

/** The precedence key of a candidate rule (higher is more specific). */
function ruleSpecificity(rule: HandymanServicePriceRuleRecord): number[] {
  const bandWidth =
    rule.minQuantity === null && rule.maxQuantity === null
      ? Number.MAX_SAFE_INTEGER
      : (rule.maxQuantity ?? Number.MAX_SAFE_INTEGER) -
        (rule.minQuantity ?? 0);
  return [
    rule.serviceVariantId === null ? 0 : 1,
    -bandWidth,
    Object.keys(rule.attributeSelector).length,
  ];
}

function isStrictlyMoreSpecific(
  a: number[],
  b: number[],
): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function isSameSpecificity(a: number[], b: number[]): boolean {
  return a.every((value, index) => value === b[index]);
}

/**
 * Resolve ONE request item's price.
 *
 * The resolver never mutates anything — it is a pure read over governed
 * facts plus the caller's effective date.
 */
export async function resolveHandymanRequestItemPrice(
  item: HandymanServiceRequestItemRecord,
  context: HandymanPriceResolutionContext,
): Promise<HandymanPriceResolutionDraft> {
  const service = await serviceCatalogRepository.findById(
    undefined,
    item.serviceCatalogId,
  );
  if (!service) {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'PRICE_RULE_NOT_FOUND',
      'The referenced catalogue service no longer exists.',
    );
  }

  // 1) Attribute validation.
  const attributes = await handymanParameterizedCatalogRepository.listAttributes(
    undefined,
    context.clientId,
    service.id,
    'ACTIVE',
  );
  const attributeProblem = validateItemAttributes(item, attributes);
  if (attributeProblem) {
    return notPriced(
      item.id,
      'INSPECTION_REQUIRED',
      attributeProblem.reasonCode,
      attributeProblem.detail,
    );
  }

  // 2) Commercial posture.
  const profile =
    await handymanParameterizedCatalogRepository.findCommercialProfileByService(
      undefined,
      service.id,
    );
  if (!profile) {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'COMMERCIAL_PROFILE_MISSING',
      'No commercial profile is configured for this service.',
    );
  }
  if (profile.pricingMode === 'INSPECTION_FIRST') {
    return notPriced(
      item.id,
      'INSPECTION_REQUIRED',
      'PRICING_MODE_INSPECTION_FIRST',
      'This service is priced only after an inspection.',
    );
  }

  // 3) Variant coherence.
  if (item.serviceVariantId !== null) {
    const variant =
      await handymanParameterizedCatalogRepository.findVariantById(
        undefined,
        item.serviceVariantId,
      );
    if (
      !variant ||
      variant.clientId !== context.clientId ||
      variant.serviceCatalogId !== service.id
    ) {
      return notPriced(
        item.id,
        'MANUAL_REVIEW',
        'SERVICE_VARIANT_MISMATCH',
        'The referenced service variant does not belong to this service.',
      );
    }
  }

  // 4) Rule selection.
  const rules = await handymanParameterizedCatalogRepository.listPriceRules(
    undefined,
    context.clientId,
    service.id,
    'ACTIVE',
  );
  const candidates = rules.filter((rule) => ruleMatchesItem(rule, item));
  if (candidates.length === 0) {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'PRICE_RULE_NOT_FOUND',
      'No price rule matches this service, attribute combination and quantity.',
    );
  }

  // 5) The governed price fact behind each candidate.
  const priced: {
    rule: HandymanServicePriceRuleRecord;
    entry: Awaited<
      ReturnType<
        typeof handymanParameterizedCatalogRepository.findPriceCatalogEntryById
      >
    >;
  }[] = [];
  for (const rule of candidates) {
    const entry =
      await handymanParameterizedCatalogRepository.findPriceCatalogEntryById(
        undefined,
        rule.priceCatalogEntryId,
      );
    if (!entry) continue;
    // A Building-scoped price only applies to its own Building.
    if (entry.buildingId !== null && entry.buildingId !== context.buildingId) {
      continue;
    }
    priced.push({ rule, entry });
  }
  if (priced.length === 0) {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'PRICE_RULE_NOT_FOUND',
      'No price rule resolves to a governed price for this building.',
    );
  }

  // 6) Deterministic selection; genuinely equal candidates are ambiguous.
  const sorted = [...priced].sort((a, b) => {
    const specA = ruleSpecificity(a.rule);
    const specB = ruleSpecificity(b.rule);
    if (isStrictlyMoreSpecific(specA, specB)) return -1;
    if (isStrictlyMoreSpecific(specB, specA)) return 1;
    return a.rule.ruleCode.localeCompare(b.rule.ruleCode);
  });
  const best = sorted[0];
  const runnerUp = sorted[1];
  if (
    runnerUp &&
    isSameSpecificity(
      ruleSpecificity(best.rule),
      ruleSpecificity(runnerUp.rule),
    )
  ) {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'PRICE_RULE_AMBIGUOUS',
      `Price rules ${best.rule.ruleCode} and ${runnerUp.rule.ruleCode} match equally; manual review is required.`,
    );
  }

  const entry = best.entry;
  if (!entry) {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'PRICE_NOT_AVAILABLE',
      'The governed price fact is not resolvable.',
    );
  }
  if (entry.status !== 'ACTIVE') {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'PRICE_NOT_AVAILABLE',
      'The governed price fact is not ACTIVE.',
    );
  }
  if (entry.sourceMode !== 'SERVICE' || entry.serviceId !== service.id) {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'PRICE_NOT_AVAILABLE',
      'The governed price fact does not price this service.',
    );
  }
  const effectiveFrom = entry.effectiveFrom;
  const effectiveTo = entry.effectiveTo;
  if (
    effectiveFrom.getTime() > context.effectiveAt.getTime() ||
    (effectiveTo !== null &&
      effectiveTo.getTime() <= context.effectiveAt.getTime())
  ) {
    return notPriced(
      item.id,
      'INSPECTION_REQUIRED',
      'PRICE_NOT_AVAILABLE',
      'The governed price fact is not effective at the requested date.',
    );
  }

  // 7) The quantity UOM of the price basis.
  const uomCode = BASIS_UOM_CODE[best.rule.priceBasis];
  const uom = await handymanParameterizedCatalogRepository.findUnitOfMeasureByCode(
    undefined,
    context.clientId,
    uomCode,
  );
  if (!uom) {
    return notPriced(
      item.id,
      'MANUAL_REVIEW',
      'UNIT_OF_MEASURE_MISSING',
      `The client is missing the ${uomCode} unit of measure required by this price basis.`,
    );
  }

  const unitAmount = Number(entry.unitPrice);
  const computedTotal = Math.round(item.quantity * unitAmount * 100) / 100;
  return {
    requestItemId: item.id,
    outcome: 'PRICED',
    reasonCode: 'PRICE_RESOLVED',
    reasonDetail: null,
    priceRuleId: best.rule.id,
    priceCatalogEntryId: entry.id,
    currency: entry.currency,
    unitAmount,
    quantity: item.quantity,
    priceBasis: best.rule.priceBasis,
    effectiveFrom,
    effectiveTo,
    computedTotal,
    uomId: uom.id,
  };
}
