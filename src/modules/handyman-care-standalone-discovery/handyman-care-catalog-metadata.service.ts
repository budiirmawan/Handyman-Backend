import { AppError, ERROR_CODES } from '../../shared/errors';
import { requireActiveAssignedBuilding } from './handyman-care-standalone-discovery.service';
import {
  handymanCareCatalogMetadataRepository,
  type CareCatalogAttributeRecord,
  type CareCatalogQuantityConstraintRecord,
  type CareCatalogServiceMetadataRecord,
  type CareCatalogUomRecord,
  type CareCatalogVariantAttributeRecord,
  type CareCatalogVariantRecord,
} from './handyman-care-catalog-metadata.repository';

/**
 * CR-HM-BE-CARE-CATALOG-METADATA-01 PART 06 — authorized Building-session
 * catalogue metadata for the structured intake UI.
 *
 * This is a READ-ONLY intake capability. It answers the three questions the
 * PART 04 create contract implicitly requires the caller to know:
 *
 *   1. which technical attributes does an ACTIVE service declare, with what
 *      type, allowed options and constraints;
 *   2. which ACTIVE variants exist and exactly which attribute values each
 *      variant INHERITS;
 *   3. which ACTIVE Client-owned units of measure may be reported.
 *
 * AUTHORITY: the same chain PART 04 already uses — an authenticated Backend
 * Care staff session, the dedicated `handyman.care.building` permission
 * (enforced at the transport) and `requireActiveAssignedBuilding` for the
 * exact ACTIVE Building plus its active Client/Property lineage. The Client
 * is DERIVED server-side; the caller never supplies it. No `service_catalog.read`
 * or `uom.read` grant is added, widened or bypassed.
 *
 * NOT A NEW POLICY SURFACE: nothing here creates, edits, prices, approves or
 * schedules. It reads the governed masters through a client-scoped
 * projection. Inactive services and inactive variants stay unavailable
 * exactly as they are at create time (the item engine refuses both).
 */

/**
 * Non-enumerating "not found" for the metadata read.
 *
 * An INACTIVE service, a service of another Client and a genuinely absent id
 * all answer with the same 404, so this endpoint can never become an
 * existence oracle for a foreign catalogue.
 */
function careCatalogServiceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_CATALOG_NOT_FOUND,
    message: 'Service catalogue entry not found.',
    statusCode: 404,
  });
}

/**
 * The static applicability statement.
 *
 * These are FACTS ABOUT THE SOURCE MODEL, not new rules. They exist because
 * the intake UI must not be told a comfortable lie:
 *   - no service-to-UOM mapping is governed, so no per-service UOM list may
 *     be invented (the Backend validates only ACTIVE + same Client);
 *   - a reported UOM is an intake fact, never the quotation pricing UOM;
 *   - only ACTIVE services and ACTIVE variants are selectable, which is what
 *     the create engine enforces.
 */
const APPLICABILITY = {
  serviceScope: 'CLIENT' as const,
  reportableServiceStatuses: ['ACTIVE'] as const,
  selectableVariantStatuses: ['ACTIVE'] as const,
  uomScope: 'CLIENT' as const,
  serviceUomApplicability: 'NOT_GOVERNED' as const,
  attributeScope: 'SERVICE' as const,
  attributeInheritance: 'VARIANT_MATERIALISED' as const,
  notes: [
    'No service-to-UOM mapping is governed in the source model: every ACTIVE unit of measure owned by the Client may be reported on a request item, and the Backend validates only ACTIVE status and Client ownership. No per-service UOM applicability is inferred.',
    'A reported UOM is an intake fact and is NOT the quotation pricing UOM. Pricing basis is an Operations-only quotation decision and is not exposed here.',
    'Variant attribute values are inherited deterministically when an item is authored and materialised on the item; an explicit attribute value that contradicts the selected variant is refused, never silently overwritten.',
    'Technical attribute intake is permissive about unrecognized values: a reported value outside the governed vocabulary is retained for the inspection/manual-review lane instead of being rejected here.',
  ],
} as const;

/**
 * Presentation label for one unit of measure.
 *
 * A convenience composition of the two governed display parts (`name` and
 * `symbol`) — it is NOT a governed catalogue field and never replaces `code`
 * (the machine key) or `id` (the stable identifier the create contract
 * accepts).
 */
function uomDisplayLabel(uom: CareCatalogUomRecord): string {
  return `${uom.name} (${uom.symbol})`;
}

function projectAttribute(
  attribute: CareCatalogAttributeRecord,
  variantConfiguredAttributeIds: ReadonlySet<string>,
) {
  return {
    id: attribute.id,
    code: attribute.code,
    name: attribute.name,
    description: attribute.description,
    dataType: attribute.dataType,
    unit: attribute.unit,
    required: attribute.required,
    allowFreeValue: attribute.allowFreeValue,
    allowedValues: attribute.allowedValues ?? [],
    sortOrder: attribute.sortOrder,
    status: attribute.status,
    // DERIVED applicability: an ACTIVE variant of this service configures
    // this attribute, so selecting that variant inherits a value for it.
    // The attribute definition itself is SERVICE-scoped (there is no
    // per-variant attribute definition table in the source model).
    variantApplicable: variantConfiguredAttributeIds.has(attribute.id),
  };
}

/**
 * The single normalized form of a materialised variant value.
 *
 * This MIRRORS the item engine's inheritance normalizer
 * (`loadVariantAttributeValues`: `valueText ?? String(valueNumber)`,
 * trimmed) on purpose. If this projection used its own formatting — e.g. the
 * NUMERIC column text `'0.5000'` instead of `'0.5'` — the UI would be told a
 * value the create contract then echoes back differently in
 * `inheritedAttributeCodes`/`attributeValues`. One vocabulary, one form.
 *
 * A configured row whose value normalizes to nothing is NOT inherited by the
 * item engine either, so it is dropped here rather than advertised.
 */
function normalizeVariantAttributeValue(
  value: CareCatalogVariantAttributeRecord,
): string | null {
  const raw =
    value.valueText !== null
      ? value.valueText
      : value.valueNumber !== null
        ? String(value.valueNumber)
        : null;
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function projectVariantAttribute(
  value: CareCatalogVariantAttributeRecord,
  normalized: string,
) {
  return {
    attributeId: value.attributeId,
    code: value.code,
    name: value.name,
    dataType: value.dataType,
    unit: value.unit,
    valueText: value.valueText,
    valueNumber: value.valueNumber,
    value: normalized,
  };
}

function projectVariant(variant: CareCatalogVariantRecord) {
  const inheritedAttributeValues: {
    record: CareCatalogVariantAttributeRecord;
    normalized: string;
  }[] = [];
  for (const value of variant.inheritedAttributeValues ?? []) {
    const normalized = normalizeVariantAttributeValue(value);
    // Not inherited by the item engine -> not advertised here.
    if (normalized === null) continue;
    inheritedAttributeValues.push({ record: value, normalized });
  }
  return {
    id: variant.id,
    code: variant.code,
    name: variant.name,
    description: variant.description,
    status: variant.status,
    inheritedAttributeValues: inheritedAttributeValues.map(({ record, normalized }) =>
      projectVariantAttribute(record, normalized),
    ),
    // The provenance statement, mirroring the request-item projection: the
    // attribute codes this variant supplies to an authored item.
    inheritedAttributeCodes: inheritedAttributeValues
      .map(({ record }) => record.code)
      .sort(),
  };
}

function projectQuantityConstraint(
  constraint: CareCatalogQuantityConstraintRecord,
) {
  // Quantity BOUNDS only. No rule identity, no price basis, no amount, no
  // currency and no price-catalogue reference leaves this projection.
  return {
    serviceVariantId: constraint.serviceVariantId,
    minimum: constraint.minimum,
    maximum: constraint.maximum,
  };
}

function project(
  record: CareCatalogServiceMetadataRecord,
): Record<string, unknown> {
  const variants = record.variants ?? [];
  const variantConfiguredAttributeIds = new Set<string>();
  for (const variant of variants) {
    for (const value of variant.inheritedAttributeValues ?? []) {
      if (normalizeVariantAttributeValue(value) === null) continue;
      variantConfiguredAttributeIds.add(value.attributeId);
    }
  }

  return {
    service: record.service,
    attributes: (record.attributes ?? []).map((attribute) =>
      projectAttribute(attribute, variantConfiguredAttributeIds),
    ),
    variants: variants.map(projectVariant),
    quantityConstraints: (record.quantityConstraints ?? []).map(
      projectQuantityConstraint,
    ),
    unitsOfMeasure: (record.unitsOfMeasure ?? []).map((uom) => ({
      id: uom.id,
      code: uom.code,
      name: uom.name,
      symbol: uom.symbol,
      category: uom.category,
      displayLabel: uomDisplayLabel(uom),
    })),
    applicability: APPLICABILITY,
  };
}

/**
 * Read the metadata of ONE ACTIVE service of the authorized Building's Client.
 *
 * The Building/Client pair is proven BEFORE any catalogue lookup, so an
 * unauthorized Building costs exactly one rejection and never touches the
 * catalogue. The lookup is then keyed by that server-derived Client, which is
 * what makes a cross-Client id indistinguishable from an absent one.
 */
export async function getBuildingCareCatalogueServiceMetadata(input: {
  actorUserId: string;
  buildingId: string;
  serviceCatalogId: string;
}): Promise<Record<string, unknown>> {
  const { authority } = await requireActiveAssignedBuilding(
    input.actorUserId,
    input.buildingId,
  );
  const record =
    await handymanCareCatalogMetadataRepository.findServiceMetadata(
      authority.scope.clientId,
      input.serviceCatalogId,
    );
  if (!record) throw careCatalogServiceNotFoundError();
  return project(record);
}
