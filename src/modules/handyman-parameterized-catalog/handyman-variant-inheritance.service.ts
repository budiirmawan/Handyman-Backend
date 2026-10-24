import { handymanServiceRequestItemInvalidError } from './handyman-parameterized-catalog.errors';
import { handymanParameterizedCatalogRepository } from './handyman-parameterized-catalog.repository';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 03 — the VARIANT INHERITANCE contract.
 *
 * A service variant is the CATALOGUE-LEVEL configuration of a service: it
 * says "this variant is a 1.5 PK inverter split unit with no existing unit".
 * A request item is the WORK fact: how many, which building, which access
 * condition. The variant therefore OWNS a set of attribute values, and an
 * item INHERITS them.
 *
 * The contract, in full:
 *
 *   1. DETERMINISTIC INHERITANCE — the effective attribute set of an item
 *      is the variant's ACTIVE configured values plus the caller's own
 *      values for the attributes the variant does not configure. The set is
 *      MATERIALISED on the item row, so the price resolution and the
 *      quotation snapshot read exactly the values that were inherited.
 *
 *   2. NO SILENT CONTRADICTION — when the item is authored, an explicit
 *      value that CONTRADICTS a variant-configured value is REFUSED
 *      (400) with the attribute code, the variant value and the submitted
 *      value. A silent "last write wins" would let a price rule select one
 *      tier while the item states another.
 *
 *   3. GOVERNED CORRECTION — after authoring, the inspection lane MAY
 *      correct an inherited value. That correction is explicit, audited,
 *      and the price then re-resolves against the CORRECTED value: a tier
 *      that no longer matches fails closed to MANUAL_REVIEW. It never
 *      produces a price from a tier the item does not match.
 *
 *   4. RETIRED CHOICES ARE NOT INHERITED — a variant choice that was
 *      retired (PART 02 lifecycle) never reaches a new item.
 *
 *   5. THE CATALOGUE NEVER REWRITES AN EXISTING ITEM — a later change of
 *      the variant does not flow into an item that already exists; the
 *      item keeps the values it was authored with. The variant is re-read
 *      only when the variant is (re)SELECTED.
 *
 * The service never computes a price, never changes a quantity, never
 * touches a UOM and never touches the access complexity: it only decides
 * WHICH attribute values the item carries.
 */

/** The attribute values a variant configures (ACTIVE choices only). */
export type VariantAttributeValues = Record<string, string>;

/**
 * The effective attribute set of a request item plus the provenance of the
 * inherited part.
 */
export type EffectiveItemAttributes = {
  /** The EFFECTIVE set — what the price resolution reads. */
  attributeValues: Record<string, string>;
  /** The part that came from the variant — the provenance. */
  inheritedAttributeValues: Record<string, string>;
  /** The attribute codes the variant supplied (audit + API projection). */
  inheritedCodes: string[];
};

/**
 * The ACTIVE attribute values configured by one variant.
 *
 * A retired choice is never inherited; a choice whose attribute definition
 * has been retired is skipped as well (the attribute is no longer part of
 * the service's vocabulary).
 */
export async function loadVariantAttributeValues(
  clientId: string,
  serviceVariantId: string,
): Promise<VariantAttributeValues> {
  const rows = await handymanParameterizedCatalogRepository.listVariantAttributeValues(
    undefined,
    clientId,
    serviceVariantId,
  );
  const values: VariantAttributeValues = {};
  for (const row of rows) {
    // A RETIRED choice (the PART 02 lifecycle) is never inherited, and a
    // choice whose attribute definition was retired is skipped as well —
    // the attribute is no longer part of the service's vocabulary.
    if (row.choiceStatus !== 'ACTIVE') continue;
    if (row.attributeStatus !== 'ACTIVE') continue;
    const value =
      row.valueText !== null
        ? row.valueText
        : row.valueNumber !== null
          ? String(row.valueNumber)
          : null;
    if (value === null || value.trim().length === 0) continue;
    values[row.attributeCode] = value.trim();
  }
  return values;
}

/**
 * Compose the effective attribute set of an item.
 *
 * `ownValues` are the values the CALLER stated (never the previously
 * inherited ones). `pinnedInherited` are the values the item was already
 * authored with (used when the variant is NOT re-selected, so a catalogue
 * change cannot rewrite an existing item).
 */
export function composeEffectiveItemAttributes(input: {
  variantValues: VariantAttributeValues;
  ownValues: Record<string, string>;
  pinnedInherited?: Record<string, string>;
  /** The variant code, used in the conflict message. */
  variantLabel?: string | null;
}): EffectiveItemAttributes {
  const inherited: Record<string, string> = {};
  const effective: Record<string, string> = {};

  for (const [code, value] of Object.entries(input.ownValues)) {
    const own = value.trim();
    const variantValue = input.variantValues[code];
    if (variantValue !== undefined && variantValue !== own) {
      // 2. NO SILENT CONTRADICTION.
      throw handymanServiceRequestItemInvalidError(
        `The variant${input.variantLabel ? ` ${input.variantLabel}` : ''} configures ${code}=${variantValue}; the item may not state ${code}=${own}.`,
      );
    }
    effective[code] = own;
  }

  for (const [code, value] of Object.entries(input.variantValues)) {
    if (Object.prototype.hasOwnProperty.call(effective, code)) {
      // The caller stated the SAME value: the effective value is the
      // caller's own, the variant merely agrees.
      continue;
    }
    effective[code] = value;
    inherited[code] = value;
  }

  if (input.pinnedInherited) {
    for (const [code, value] of Object.entries(input.pinnedInherited)) {
      if (Object.prototype.hasOwnProperty.call(effective, code)) continue;
      effective[code] = value;
      inherited[code] = value;
    }
  }

  return {
    attributeValues: effective,
    inheritedAttributeValues: inherited,
    inheritedCodes: Object.keys(inherited).sort(),
  };
}

/**
 * Split an already materialised effective set back into the caller's own
 * values and the inherited part.
 *
 * The item row stores BOTH parts (`attribute_values` is the effective set,
 * `inherited_attribute_values` is the provenance), so the split is exact —
 * no guessing, no heuristic.
 */
export function splitItemAttributes(input: {
  attributeValues: Record<string, string>;
  inheritedAttributeValues: Record<string, string>;
}): { ownValues: Record<string, string>; inherited: Record<string, string> } {
  const ownValues: Record<string, string> = {};
  for (const [code, value] of Object.entries(input.attributeValues)) {
    if (
      Object.prototype.hasOwnProperty.call(
        input.inheritedAttributeValues,
        code,
      )
    ) {
      continue;
    }
    ownValues[code] = value;
  }
  return { ownValues, inherited: input.inheritedAttributeValues };
}

/**
 * The GOVERNED CORRECTION path (PART 03, rule 3).
 *
 * The variant of an item is NOT re-selected, so the catalogue may not
 * rewrite the item: the values the item was authored with stay pinned. The
 * caller may still CORRECT an inherited value — that is the inspection
 * lane — and the correction becomes the item's OWN value (it leaves the
 * inherited set), so the price re-resolves against the corrected value and
 * a tier that no longer matches fails closed.
 *
 * The CURRENT catalogue values are not applied here: a catalogue change
 * never flows into an item that already exists.
 */
export function composeCorrectedItemAttributes(input: {
  ownValues: Record<string, string>;
  pinnedInherited: Record<string, string>;
}): EffectiveItemAttributes {
  const effective: Record<string, string> = { ...input.pinnedInherited };
  const inherited: Record<string, string> = {};
  for (const [code, value] of Object.entries(input.pinnedInherited)) {
    inherited[code] = value;
  }
  for (const [code, value] of Object.entries(input.ownValues)) {
    const trimmed = value.trim();
    effective[code] = trimmed;
    // A corrected value is the caller's own value from now on.
    delete inherited[code];
  }
  return {
    attributeValues: effective,
    inheritedAttributeValues: inherited,
    inheritedCodes: Object.keys(inherited).sort(),
  };
}
