import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleClientIds,
} from '../context-access';
import {
  serviceCatalogNotActiveError,
  serviceCatalogNotFoundError,
  serviceCatalogRepository,
} from '../service-catalog';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanParameterizedCatalogRepository,
} from './handyman-parameterized-catalog.repository';
import {
  handymanServiceAttributeAlreadyExistsError,
  handymanServiceAttributeInvalidError,
  handymanServiceAttributeNotFoundError,
  handymanServiceCommercialProfileNotFoundError,
  handymanServicePriceRuleAlreadyExistsError,
  handymanServicePriceRuleCollisionError,
  handymanServicePriceRuleInvalidError,
  handymanServicePriceRuleNotFoundError,
  handymanServiceVariantAttributeAlreadyExistsError,
  handymanServiceVariantAttributeInvalidError,
  handymanServiceVariantAttributeNotFoundError,
  handymanServiceVariantNotFoundError,
} from './handyman-parameterized-catalog.errors';
import {
  isHandymanServiceAccessCondition,
  isHandymanServiceAttributeDataType,
  isHandymanServicePriceBasis,
  isHandymanServicePricingMode,
  HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY,
  type HandymanServiceAccessCondition,
  type HandymanServiceAttributeAllowedValue,
  type HandymanServiceAttributeDataType,
  type HandymanServiceAttributeRecord,
  type HandymanServiceCategoryRecord,
  type HandymanServicePriceBasis,
  type HandymanServicePriceRuleRecord,
  type HandymanServicePricingMode,
  type PublicHandymanServiceAttribute,
  type PublicHandymanServiceCategory,
  type PublicHandymanServiceCommercialProfile,
  type PublicHandymanServicePriceRule,
  type PublicHandymanServiceVariantAttribute,
} from './handyman-parameterized-catalog.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — parameterized catalogue admin
 * commands and reads.
 *
 * Scope law: the catalogue is Client-scoped (the same convention as
 * `service_catalog`), so every write asserts the caller's Client reach and
 * derives `clientId` from the addressed service entry — never from the
 * caller. Every read is Client-scoped, and a foreign Client never leaks an
 * existence signal (the no-leak posture of `service_catalog`).
 *
 * The module owns NO amount: a price rule POINTS at the existing governed
 * price authority (`price_catalog_entries`). An administrator cannot create
 * a rule against a MATERIAL price entry, against another Client's entry, or
 * against a different service.
 */

const ATTRIBUTE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const RULE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;

function toPublicCategory(
  record: HandymanServiceCategoryRecord,
): PublicHandymanServiceCategory {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicAttribute(
  record: HandymanServiceAttributeRecord,
): PublicHandymanServiceAttribute {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicPriceRule(
  record: HandymanServicePriceRuleRecord,
): PublicHandymanServicePriceRule {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

/**
 * Resolve the addressed service entry and prove both its existence and the
 * caller's Client reach. The Client is DERIVED from the entry — a caller can
 * never address a foreign Client's service.
 */
async function requireServiceEntry(
  serviceCatalogId: string,
  actorUserId: string,
  options: { requireActive?: boolean } = {},
): Promise<{ id: string; clientId: string; code: string; name: string }> {
  if (!isValidUuid(serviceCatalogId)) {
    throw AppError.validation('Catalog validation failed.', [
      { field: 'serviceCatalogId', message: 'serviceCatalogId must be a valid UUID.' },
    ]);
  }
  const entry = await serviceCatalogRepository.findById(
    undefined,
    serviceCatalogId,
  );
  if (!entry) throw serviceCatalogNotFoundError();
  if (options.requireActive && entry.status !== 'ACTIVE') {
    throw serviceCatalogNotActiveError();
  }
  await assertClientAccess(actorUserId, entry.clientId);
  return {
    id: entry.id,
    clientId: entry.clientId,
    code: entry.code,
    name: entry.name,
  };
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

/** The governed category vocabulary of one Client. */
export async function listHandymanServiceCategories(
  clientId: string,
  actorUserId: string,
): Promise<PublicHandymanServiceCategory[]> {
  if (!isValidUuid(clientId)) {
    throw AppError.validation('Catalog validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  await assertClientAccess(actorUserId, clientId);
  const records = await handymanParameterizedCatalogRepository.listCategories(
    undefined,
    clientId,
  );
  return records.map(toPublicCategory);
}

/* ------------------------------------------------------------------ */
/* Attribute definitions                                               */
/* ------------------------------------------------------------------ */

export type CreateHandymanServiceAttributeInput = {
  code: string;
  name: string;
  description?: string;
  dataType: HandymanServiceAttributeDataType;
  unit?: string;
  required?: boolean;
  allowFreeValue?: boolean;
  allowedValues?: HandymanServiceAttributeAllowedValue[];
  sortOrder?: number;
};

function normalizeAllowedValues(
  raw: unknown,
  dataType: HandymanServiceAttributeDataType,
): HandymanServiceAttributeAllowedValue[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw handymanServiceAttributeInvalidError(
      'allowedValues must be an array of { code, label } objects.',
    );
  }
  const seen = new Set<string>();
  const out: HandymanServiceAttributeAllowedValue[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw handymanServiceAttributeInvalidError(
        'allowedValues entries must be objects with code and label.',
      );
    }
    const code = String((entry as { code?: unknown }).code ?? '').trim();
    const label = String((entry as { label?: unknown }).label ?? '').trim();
    if (code.length < 1 || code.length > 64) {
      throw handymanServiceAttributeInvalidError(
        'allowedValues[].code must be 1-64 characters.',
      );
    }
    if (label.length < 1 || label.length > 200) {
      throw handymanServiceAttributeInvalidError(
        'allowedValues[].label must be 1-200 characters.',
      );
    }
    if (seen.has(code)) {
      throw handymanServiceAttributeInvalidError(
        `allowedValues contains a duplicate code: ${code}.`,
      );
    }
    seen.add(code);
    out.push({ code, label });
  }
  if (dataType === 'ENUM' && out.length === 0) {
    throw handymanServiceAttributeInvalidError(
      'An ENUM attribute requires at least one allowed value.',
    );
  }
  return out;
}

export async function createHandymanServiceAttribute(
  serviceCatalogId: string,
  input: CreateHandymanServiceAttributeInput,
  actorUserId: string,
): Promise<PublicHandymanServiceAttribute> {
  const service = await requireServiceEntry(serviceCatalogId, actorUserId, {
    requireActive: true,
  });

  if (!isHandymanServiceAttributeDataType(input.dataType)) {
    throw handymanServiceAttributeInvalidError(
      'dataType must be NUMBER, TEXT, ENUM or BOOLEAN.',
    );
  }
  const code = String(input.code ?? '').trim().toUpperCase();
  if (!ATTRIBUTE_CODE_PATTERN.test(code) || code.length < 2 || code.length > 64) {
    throw handymanServiceAttributeInvalidError(
      'code must start with a letter and contain only uppercase letters, digits, underscore or hyphen (2-64 characters).',
    );
  }
  const name = String(input.name ?? '').trim();
  if (name.length < 1 || name.length > 200) {
    throw handymanServiceAttributeInvalidError(
      'name is required (1-200 characters).',
    );
  }
  let description: string | null = null;
  if (input.description !== undefined) {
    description = String(input.description).trim() || null;
    if (description && description.length > 1000) {
      throw handymanServiceAttributeInvalidError(
        'description must be at most 1000 characters.',
      );
    }
  }
  let unit: string | null = null;
  if (input.unit !== undefined) {
    unit = String(input.unit).trim() || null;
    if (unit && unit.length > 32) {
      throw handymanServiceAttributeInvalidError(
        'unit must be at most 32 characters.',
      );
    }
  }
  const allowedValues = normalizeAllowedValues(
    input.allowedValues,
    input.dataType,
  );
  const sortOrder = Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : 0;

  const existing = await handymanParameterizedCatalogRepository.findAttributeByCode(
    undefined,
    service.id,
    code,
  );
  if (existing) throw handymanServiceAttributeAlreadyExistsError();

  return withTransaction(async (tx) => {
    const record = await handymanParameterizedCatalogRepository.insertAttribute(
      tx as never,
      {
        clientId: service.clientId,
        serviceCatalogId: service.id,
        code,
        name,
        description,
        dataType: input.dataType,
        unit,
        required: Boolean(input.required),
        allowFreeValue: Boolean(input.allowFreeValue),
        allowedValues,
        sortOrder,
        status: 'ACTIVE',
        createdByUserId: actorUserId,
      },
    );
    await recordOperationalEvent(
      {
        clientId: service.clientId,
        eventType: 'HANDYMAN_SERVICE_ATTRIBUTE_CREATED',
        entityType: 'HANDYMAN_SERVICE_ATTRIBUTE',
        entityId: record.id,
        actorUserId,
        summary: `Handyman service attribute ${code} created for service ${service.code}.`,
        metadata: {
          serviceCatalogId: service.id,
          attributeCode: code,
          dataType: record.dataType,
        },
      },
      tx,
    );
    return toPublicAttribute(record);
  });
}

export type UpdateHandymanServiceAttributeInput = {
  name?: string;
  description?: string | null;
  unit?: string | null;
  required?: boolean;
  allowFreeValue?: boolean;
  allowedValues?: HandymanServiceAttributeAllowedValue[];
  sortOrder?: number;
  status?: 'ACTIVE' | 'INACTIVE';
};

export async function updateHandymanServiceAttribute(
  attributeId: string,
  input: UpdateHandymanServiceAttributeInput,
  actorUserId: string,
): Promise<PublicHandymanServiceAttribute> {
  if (!isValidUuid(attributeId)) {
    throw AppError.validation('Catalog validation failed.', [
      { field: 'attributeId', message: 'attributeId must be a valid UUID.' },
    ]);
  }
  const existing = await handymanParameterizedCatalogRepository.findAttributeById(
    undefined,
    attributeId,
  );
  if (!existing) throw handymanServiceAttributeNotFoundError();
  await assertClientAccess(actorUserId, existing.clientId);

  const patch: {
    name?: string;
    description?: string | null;
    unit?: string | null;
    required?: boolean;
    allowFreeValue?: boolean;
    allowedValues?: HandymanServiceAttributeAllowedValue[];
    sortOrder?: number;
    status?: 'ACTIVE' | 'INACTIVE';
  } = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (name.length < 1 || name.length > 200) {
      throw handymanServiceAttributeInvalidError(
        'name is required (1-200 characters).',
      );
    }
    patch.name = name;
  }
  if (input.description !== undefined) {
    const description = String(input.description).trim() || null;
    if (description && description.length > 1000) {
      throw handymanServiceAttributeInvalidError(
        'description must be at most 1000 characters.',
      );
    }
    patch.description = description;
  }
  if (input.unit !== undefined) {
    const unit = String(input.unit).trim() || null;
    if (unit && unit.length > 32) {
      throw handymanServiceAttributeInvalidError(
        'unit must be at most 32 characters.',
      );
    }
    patch.unit = unit;
  }
  if (input.required !== undefined) patch.required = Boolean(input.required);
  if (input.allowFreeValue !== undefined) {
    patch.allowFreeValue = Boolean(input.allowFreeValue);
  }
  if (input.allowedValues !== undefined) {
    patch.allowedValues = normalizeAllowedValues(
      input.allowedValues,
      existing.dataType,
    );
  }
  if (input.sortOrder !== undefined) {
    if (!Number.isInteger(input.sortOrder)) {
      throw handymanServiceAttributeInvalidError(
        'sortOrder must be an integer.',
      );
    }
    patch.sortOrder = Number(input.sortOrder);
  }
  if (input.status !== undefined) {
    if (input.status !== 'ACTIVE' && input.status !== 'INACTIVE') {
      throw handymanServiceAttributeInvalidError(
        'status must be ACTIVE or INACTIVE.',
      );
    }
    patch.status = input.status;
  }

  return withTransaction(async (tx) => {
    const updated = await handymanParameterizedCatalogRepository.updateAttribute(
      tx as never,
      attributeId,
      patch,
    );
    if (!updated) throw handymanServiceAttributeNotFoundError();
    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        eventType: 'HANDYMAN_SERVICE_ATTRIBUTE_UPDATED',
        entityType: 'HANDYMAN_SERVICE_ATTRIBUTE',
        entityId: updated.id,
        actorUserId,
        summary: `Handyman service attribute ${updated.code} updated.`,
        metadata: {
          serviceCatalogId: updated.serviceCatalogId,
          attributeCode: updated.code,
        },
      },
      tx,
    );
    return toPublicAttribute(updated);
  });
}

export async function listHandymanServiceAttributes(
  serviceCatalogId: string,
  actorUserId: string,
  status?: 'ACTIVE' | 'INACTIVE',
): Promise<PublicHandymanServiceAttribute[]> {
  const service = await requireServiceEntry(serviceCatalogId, actorUserId);
  const records = await handymanParameterizedCatalogRepository.listAttributes(
    undefined,
    service.clientId,
    service.id,
    status,
  );
  return records.map(toPublicAttribute);
}

/* ------------------------------------------------------------------ */
/* Commercial profile                                                  */
/* ------------------------------------------------------------------ */

export type UpsertHandymanServiceCommercialProfileInput = {
  pricingMode: HandymanServicePricingMode;
  notes?: string | null;
};

export async function upsertHandymanServiceCommercialProfile(
  serviceCatalogId: string,
  input: UpsertHandymanServiceCommercialProfileInput,
  actorUserId: string,
): Promise<PublicHandymanServiceCommercialProfile> {
  const service = await requireServiceEntry(serviceCatalogId, actorUserId, {
    requireActive: true,
  });
  if (!isHandymanServicePricingMode(input.pricingMode)) {
    throw AppError.validation('Catalog validation failed.', [
      {
        field: 'pricingMode',
        message: 'pricingMode must be FIXED, ESTIMATED or INSPECTION_FIRST.',
      },
    ]);
  }
  const notes =
    input.notes === undefined ? null : String(input.notes).trim() || null;
  if (notes && notes.length > 1000) {
    throw AppError.validation('Catalog validation failed.', [
      { field: 'notes', message: 'notes must be at most 1000 characters.' },
    ]);
  }

  return withTransaction(async (tx) => {
    const record =
      await handymanParameterizedCatalogRepository.upsertCommercialProfile(
        tx as never,
        {
          clientId: service.clientId,
          serviceCatalogId: service.id,
          pricingMode: input.pricingMode,
          notes,
          status: 'ACTIVE',
          createdByUserId: actorUserId,
        },
      );
    await recordOperationalEvent(
      {
        clientId: service.clientId,
        eventType: 'HANDYMAN_SERVICE_COMMERCIAL_PROFILE_SET',
        entityType: 'HANDYMAN_SERVICE_COMMERCIAL_PROFILE',
        entityId: record.id,
        actorUserId,
        summary: `Handyman service commercial profile for ${service.code} set to ${input.pricingMode}.`,
        metadata: {
          serviceCatalogId: service.id,
          pricingMode: record.pricingMode,
        },
      },
      tx,
    );
    return {
      ...record,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  });
}

export async function getHandymanServiceCommercialProfile(
  serviceCatalogId: string,
  actorUserId: string,
): Promise<PublicHandymanServiceCommercialProfile> {
  const service = await requireServiceEntry(serviceCatalogId, actorUserId);
  const record =
    await handymanParameterizedCatalogRepository.findCommercialProfileByService(
      undefined,
      service.id,
    );
  if (!record) throw handymanServiceCommercialProfileNotFoundError();
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Price rules                                                         */
/* ------------------------------------------------------------------ */

export type CreateHandymanServicePriceRuleInput = {
  ruleCode: string;
  priceCatalogEntryId: string;
  priceBasis: HandymanServicePriceBasis;
  serviceVariantId?: string | null;
  attributeSelector?: Record<string, string>;
  minQuantity?: number | null;
  maxQuantity?: number | null;
};

function normalizeQuantity(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw handymanServicePriceRuleInvalidError(
      `${field} must be a positive number when provided.`,
    );
  }
  return parsed;
}

function normalizeAttributeSelector(
  raw: unknown,
): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw handymanServicePriceRuleInvalidError(
      'attributeSelector must be an object of attribute code to value.',
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const code = key.trim().toUpperCase();
    if (!ATTRIBUTE_CODE_PATTERN.test(code) || code.length < 2 || code.length > 64) {
      throw handymanServicePriceRuleInvalidError(
        `attributeSelector key "${key}" is not a valid attribute code.`,
      );
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw handymanServicePriceRuleInvalidError(
        `attributeSelector["${code}"] must be a non-empty string.`,
      );
    }
    // CR-HM-SERVICE-CATALOG-01 PART 02 — the access complexity of a request
    // item is NOT a service attribute; it is the reserved selector key
    // ACCESS_CONDITION and its value must come from the governed access
    // vocabulary. Every other key keeps the plain attribute-code rule.
    if (code === HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY) {
      const access = value.trim().toUpperCase();
      if (!isHandymanServiceAccessCondition(access)) {
        throw handymanServicePriceRuleInvalidError(
          `attributeSelector["${HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY}"] must be one of STANDARD, DIFFICULT, HIGH_FLOOR, RESTRICTED or SPECIAL_EQUIPMENT.`,
        );
      }
      out[code] = access;
      continue;
    }
    out[code] = value.trim();
  }
  return out;
}

/**
 * CR-HM-SERVICE-CATALOG-01 PART 02 — the PRICE TIER coherence law between a
 * price rule and the governed price fact it consumes.
 *
 *   - the plain service reference price ('') is usable by any rule;
 *   - a tiered price must carry exactly this rule's code as its tier key;
 *   - an ACCESS rule (a rule that names ACCESS_CONDITION) must consume its
 *     OWN tier: the plain reference price is the client's STANDARD-access
 *     baseline, so consuming it for a difficult / high-floor /
 *     special-equipment job would silently price the wrong access tier.
 */
function assertPriceTierCoherence(
  ruleCode: string,
  attributeSelector: Record<string, string>,
  entry: { servicePriceKey: string | null },
): void {
  const priceKey = entry.servicePriceKey ?? '';
  if (priceKey !== '' && priceKey !== ruleCode) {
    throw handymanServicePriceRuleInvalidError(
      `The referenced price fills the catalogue price tier "${priceKey}"; only a rule with that code may consume it.`,
    );
  }
  const accessKey = attributeSelector[
    HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY
  ];
  if (accessKey !== undefined && priceKey !== ruleCode) {
    throw handymanServicePriceRuleInvalidError(
      `An access rule must consume its own access price tier; the referenced price carries the tier key "${priceKey}" instead of "${ruleCode}".`,
    );
  }
}

/**
 * CR-HM-SERVICE-CATALOG-01 PART 02 — the RULE COLLISION law.
 *
 * Two ACTIVE rules of the same service that select the SAME variant, the
 * SAME attribute selection and the SAME quantity band can never be ordered
 * against each other: the resolver would have to pick one arbitrarily. The
 * administration layer refuses to create or move into such a pair, so the
 * ambiguity can only ever arrive through a direct database write — and the
 * resolver still fails closed on it.
 */
async function assertNoPriceRuleCollision(
  clientId: string,
  serviceCatalogId: string,
  candidate: {
    serviceVariantId: string | null;
    attributeSelector: Record<string, string>;
    minQuantity: number | null;
    maxQuantity: number | null;
  },
  excludeRuleId: string | null,
): Promise<void> {
  const rules = await handymanParameterizedCatalogRepository.listPriceRules(
    undefined,
    clientId,
    serviceCatalogId,
    'ACTIVE',
  );
  for (const rule of rules) {
    if (excludeRuleId !== null && rule.id === excludeRuleId) continue;
    if (rule.serviceVariantId !== candidate.serviceVariantId) continue;
    if (rule.minQuantity !== candidate.minQuantity) continue;
    if (rule.maxQuantity !== candidate.maxQuantity) continue;
    const a = Object.entries(rule.attributeSelector).sort();
    const b = Object.entries(candidate.attributeSelector).sort();
    if (
      a.length === b.length &&
      a.every(([key, value], index) => key === b[index][0] && value === b[index][1])
    ) {
      throw handymanServicePriceRuleCollisionError(
        `Price rule ${rule.ruleCode} already selects the same variant, attributes and quantity band; two equally specific rules would be ambiguous.`,
      );
    }
  }
}

export async function createHandymanServicePriceRule(
  serviceCatalogId: string,
  input: CreateHandymanServicePriceRuleInput,
  actorUserId: string,
): Promise<PublicHandymanServicePriceRule> {
  const service = await requireServiceEntry(serviceCatalogId, actorUserId, {
    requireActive: true,
  });

  const ruleCode = String(input.ruleCode ?? '').trim().toUpperCase();
  if (
    !RULE_CODE_PATTERN.test(ruleCode) ||
    ruleCode.length < 2 ||
    ruleCode.length > 64
  ) {
    throw handymanServicePriceRuleInvalidError(
      'ruleCode must start with a letter and contain only uppercase letters, digits, underscore or hyphen (2-64 characters).',
    );
  }
  if (!isHandymanServicePriceBasis(input.priceBasis)) {
    throw handymanServicePriceRuleInvalidError(
      'priceBasis must be UNIT, POINT, METER, SQM or VISIT.',
    );
  }
  if (!isValidUuid(input.priceCatalogEntryId)) {
    throw handymanServicePriceRuleInvalidError(
      'priceCatalogEntryId must be a valid UUID.',
    );
  }
  const minQuantity = normalizeQuantity(input.minQuantity, 'minQuantity');
  const maxQuantity = normalizeQuantity(input.maxQuantity, 'maxQuantity');
  if (
    minQuantity !== null &&
    maxQuantity !== null &&
    maxQuantity < minQuantity
  ) {
    throw handymanServicePriceRuleInvalidError(
      'maxQuantity must be greater than or equal to minQuantity.',
    );
  }
  const attributeSelector = normalizeAttributeSelector(input.attributeSelector);

  // The governed price fact must exist, belong to this Client, be a SERVICE
  // price and price THIS service. A rule can never point at a MATERIAL
  // price, at another Client's price, or at another service's price.
  const entry = await handymanParameterizedCatalogRepository.findPriceCatalogEntryById(
    undefined,
    input.priceCatalogEntryId,
  );
  if (!entry || entry.clientId !== service.clientId) {
    throw handymanServicePriceRuleInvalidError(
      'priceCatalogEntryId must reference a price catalog entry of this client.',
    );
  }
  if (entry.sourceMode !== 'SERVICE' || entry.serviceId !== service.id) {
    throw handymanServicePriceRuleInvalidError(
      'priceCatalogEntryId must reference an ACTIVE-capable SERVICE price entry for this service.',
    );
  }
  // CR-HM-SERVICE-CATALOG-01 PART 01/02 — the catalogue PRICE TIER of the
  // price fact must be coherent with the rule that consumes it (and, for an
  // access rule, must be the rule's OWN access tier).
  assertPriceTierCoherence(ruleCode, attributeSelector, entry);

  // The selector may only reference attribute definitions that actually
  // exist for this service — otherwise the rule could never match and would
  // silently price nothing. The reserved ACCESS_CONDITION key is not an
  // attribute and is therefore exempt from this check.
  const attributes = await handymanParameterizedCatalogRepository.listAttributes(
    undefined,
    service.clientId,
    service.id,
  );
  const knownCodes = new Set(attributes.map((a) => a.code));
  for (const code of Object.keys(attributeSelector)) {
    if (code === HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY) continue;
    if (!knownCodes.has(code)) {
      throw handymanServicePriceRuleInvalidError(
        `attributeSelector references an unknown attribute code: ${code}.`,
      );
    }
  }

  // CR-HM-SERVICE-CATALOG-01 PART 02 — no two ACTIVE rules of this service
  // may select the same variant, attributes and quantity band.
  await assertNoPriceRuleCollision(service.clientId, service.id, {
    serviceVariantId: input.serviceVariantId ?? null,
    attributeSelector,
    minQuantity,
    maxQuantity,
  }, null);

  const existingRule =
    await handymanParameterizedCatalogRepository.findPriceRuleByCode(
      undefined,
      service.clientId,
      ruleCode,
    );
  if (existingRule) throw handymanServicePriceRuleAlreadyExistsError();

  return withTransaction(async (tx) => {
    const record = await handymanParameterizedCatalogRepository.insertPriceRule(
      tx as never,
      {
        clientId: service.clientId,
        serviceCatalogId: service.id,
        serviceVariantId: input.serviceVariantId ?? null,
        ruleCode,
        priceCatalogEntryId: input.priceCatalogEntryId,
        priceBasis: input.priceBasis,
        attributeSelector,
        minQuantity,
        maxQuantity,
        status: 'ACTIVE',
        createdByUserId: actorUserId,
      },
    );
    await recordOperationalEvent(
      {
        clientId: service.clientId,
        eventType: 'HANDYMAN_SERVICE_PRICE_RULE_CREATED',
        entityType: 'HANDYMAN_SERVICE_PRICE_RULE',
        entityId: record.id,
        actorUserId,
        summary: `Handyman service price rule ${ruleCode} created for service ${service.code}.`,
        metadata: {
          serviceCatalogId: service.id,
          ruleCode,
          priceBasis: record.priceBasis,
          priceCatalogEntryId: record.priceCatalogEntryId,
        },
      },
      tx,
    );
    return toPublicPriceRule(record);
  });
}

export type UpdateHandymanServicePriceRuleInput = {
  priceCatalogEntryId?: string;
  priceBasis?: HandymanServicePriceBasis;
  serviceVariantId?: string | null;
  attributeSelector?: Record<string, string>;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  status?: 'ACTIVE' | 'INACTIVE';
};

export async function updateHandymanServicePriceRule(
  priceRuleId: string,
  input: UpdateHandymanServicePriceRuleInput,
  actorUserId: string,
): Promise<PublicHandymanServicePriceRule> {
  if (!isValidUuid(priceRuleId)) {
    throw AppError.validation('Catalog validation failed.', [
      { field: 'priceRuleId', message: 'priceRuleId must be a valid UUID.' },
    ]);
  }
  const existing = await handymanParameterizedCatalogRepository.findPriceRuleById(
    undefined,
    priceRuleId,
  );
  if (!existing) throw handymanServicePriceRuleNotFoundError();
  await assertClientAccess(actorUserId, existing.clientId);

  const patch: {
    priceCatalogEntryId?: string;
    priceBasis?: HandymanServicePriceBasis;
    serviceVariantId?: string | null;
    attributeSelector?: Record<string, string>;
    minQuantity?: number | null;
    maxQuantity?: number | null;
    status?: 'ACTIVE' | 'INACTIVE';
  } = {};

  if (input.priceCatalogEntryId !== undefined) {
    if (!isValidUuid(input.priceCatalogEntryId)) {
      throw handymanServicePriceRuleInvalidError(
        'priceCatalogEntryId must be a valid UUID.',
      );
    }
    const entry =
      await handymanParameterizedCatalogRepository.findPriceCatalogEntryById(
        undefined,
        input.priceCatalogEntryId,
      );
    if (!entry || entry.clientId !== existing.clientId) {
      throw handymanServicePriceRuleInvalidError(
        'priceCatalogEntryId must reference a price catalog entry of this client.',
      );
    }
    if (
      entry.sourceMode !== 'SERVICE' ||
      entry.serviceId !== existing.serviceCatalogId
    ) {
      throw handymanServicePriceRuleInvalidError(
        'priceCatalogEntryId must reference a SERVICE price entry for this service.',
      );
    }
    patch.priceCatalogEntryId = input.priceCatalogEntryId;
  }
  if (input.priceBasis !== undefined) {
    if (!isHandymanServicePriceBasis(input.priceBasis)) {
      throw handymanServicePriceRuleInvalidError(
        'priceBasis must be UNIT, POINT, METER, SQM or VISIT.',
      );
    }
    patch.priceBasis = input.priceBasis;
  }
  if (input.serviceVariantId !== undefined) {
    patch.serviceVariantId = input.serviceVariantId;
  }
  if (input.attributeSelector !== undefined) {
    patch.attributeSelector = normalizeAttributeSelector(input.attributeSelector);
  }
  if (input.minQuantity !== undefined) {
    patch.minQuantity = normalizeQuantity(input.minQuantity, 'minQuantity');
  }
  if (input.maxQuantity !== undefined) {
    patch.maxQuantity = normalizeQuantity(input.maxQuantity, 'maxQuantity');
  }
  if (input.status !== undefined) {
    if (input.status !== 'ACTIVE' && input.status !== 'INACTIVE') {
      throw handymanServicePriceRuleInvalidError(
        'status must be ACTIVE or INACTIVE.',
      );
    }
    patch.status = input.status;
  }

  // CR-HM-SERVICE-CATALOG-01 PART 02 — the coherence and the collision law
  // are asserted against the FINAL state of the rule (the merged selector,
  // the merged variant, the merged quantity band and the consumed price
  // fact), never against a partial view of it.
  const finalSelector = patch.attributeSelector ?? existing.attributeSelector;
  const finalVariant = patch.serviceVariantId ?? existing.serviceVariantId;
  const finalMin = patch.minQuantity !== undefined ? patch.minQuantity : existing.minQuantity;
  const finalMax = patch.maxQuantity !== undefined ? patch.maxQuantity : existing.maxQuantity;
  if (patch.attributeSelector !== undefined) {
    const attributes = await handymanParameterizedCatalogRepository.listAttributes(
      undefined,
      existing.clientId,
      existing.serviceCatalogId,
    );
    const knownCodes = new Set(attributes.map((a) => a.code));
    for (const code of Object.keys(finalSelector)) {
      if (code === HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY) continue;
      if (!knownCodes.has(code)) {
        throw handymanServicePriceRuleInvalidError(
          `attributeSelector references an unknown attribute code: ${code}.`,
        );
      }
    }
  }
  const consumedEntryId = patch.priceCatalogEntryId ?? existing.priceCatalogEntryId;
  const consumedEntry =
    await handymanParameterizedCatalogRepository.findPriceCatalogEntryById(
      undefined,
      consumedEntryId,
    );
  if (!consumedEntry || consumedEntry.clientId !== existing.clientId) {
    throw handymanServicePriceRuleInvalidError(
      'priceCatalogEntryId must reference a price catalog entry of this client.',
    );
  }
  assertPriceTierCoherence(existing.ruleCode, finalSelector, consumedEntry);
  if ((patch.status ?? existing.status) === 'ACTIVE') {
    await assertNoPriceRuleCollision(
      existing.clientId,
      existing.serviceCatalogId,
      {
        serviceVariantId: finalVariant,
        attributeSelector: finalSelector,
        minQuantity: finalMin,
        maxQuantity: finalMax,
      },
      existing.id,
    );
  }

  return withTransaction(async (tx) => {
    const updated = await handymanParameterizedCatalogRepository.updatePriceRule(
      tx as never,
      priceRuleId,
      patch,
    );
    if (!updated) throw handymanServicePriceRuleNotFoundError();
    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        eventType: 'HANDYMAN_SERVICE_PRICE_RULE_UPDATED',
        entityType: 'HANDYMAN_SERVICE_PRICE_RULE',
        entityId: updated.id,
        actorUserId,
        summary: `Handyman service price rule ${updated.ruleCode} updated.`,
        metadata: {
          serviceCatalogId: updated.serviceCatalogId,
          ruleCode: updated.ruleCode,
        },
      },
      tx,
    );
    return toPublicPriceRule(updated);
  });
}

export async function listHandymanServicePriceRules(
  clientId: string,
  actorUserId: string,
  options: { serviceCatalogId?: string; status?: 'ACTIVE' | 'INACTIVE' } = {},
): Promise<PublicHandymanServicePriceRule[]> {
  if (!isValidUuid(clientId)) {
    throw AppError.validation('Catalog validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  await assertClientAccess(actorUserId, clientId);
  const records = await handymanParameterizedCatalogRepository.listPriceRules(
    undefined,
    clientId,
    options.serviceCatalogId,
    options.status,
  );
  return records.map(toPublicPriceRule);
}

/**
 * The governed catalogue projection of one Client: the services that carry
 * the parameterized layer (attributes + commercial posture + price rules).
 * The read is Client-scoped and never leaks another Client's rows.
 */
export type HandymanServiceCatalogProjection = {
  serviceCatalogId: string;
  serviceCode: string;
  serviceName: string;
  category: string;
  status: string;
  attributes: PublicHandymanServiceAttribute[];
  commercialProfile: PublicHandymanServiceCommercialProfile | null;
  priceRules: PublicHandymanServicePriceRule[];
};

export async function listHandymanServiceCatalogProjection(
  clientId: string,
  actorUserId: string,
  options: { category?: string } = {},
): Promise<HandymanServiceCatalogProjection[]> {
  if (!isValidUuid(clientId)) {
    throw AppError.validation('Catalog validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  await assertClientAccess(actorUserId, clientId);
  const entries = await serviceCatalogRepository.listScoped(
    undefined,
    [clientId],
    {
      status: 'ACTIVE',
      ...(options.category ? { category: options.category } : {}),
    },
  );
  const filtered = entries;
  const projection: HandymanServiceCatalogProjection[] = [];
  for (const entry of filtered) {
    const attributes = await handymanParameterizedCatalogRepository.listAttributes(
      undefined,
      clientId,
      entry.id,
    );
    const profile =
      await handymanParameterizedCatalogRepository.findCommercialProfileByService(
        undefined,
        entry.id,
      );
    const rules = await handymanParameterizedCatalogRepository.listPriceRules(
      undefined,
      clientId,
      entry.id,
    );
    projection.push({
      serviceCatalogId: entry.id,
      serviceCode: entry.code,
      serviceName: entry.name,
      category: entry.category,
      status: entry.status,
      attributes: attributes.map(toPublicAttribute),
      commercialProfile: profile
        ? {
            ...profile,
            createdAt: profile.createdAt.toISOString(),
            updatedAt: profile.updatedAt.toISOString(),
          }
        : null,
      priceRules: rules.map(toPublicPriceRule),
    });
  }
  return projection;
}

/** Accessible Client ids — used by the HTTP layer for the no-leak listing. */
export async function listAccessibleClientIds(
  actorUserId: string,
): Promise<string[]> {
  return getAccessibleClientIds(actorUserId);
}

/* ------------------------------------------------------------------ */
/* CR-HM-SERVICE-CATALOG-01 PART 02 — variant attribute administration */
/* ------------------------------------------------------------------ */

function toPublicVariantAttribute(
  record: {
    id: string;
    clientId: string;
    serviceVariantId: string;
    attributeId: string;
    valueText: string | null;
    valueNumber: number | null;
    status: 'ACTIVE' | 'INACTIVE';
    deactivatedAt: Date | null;
    deactivatedByUserId: string | null;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  },
): PublicHandymanServiceVariantAttribute {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deactivatedAt: record.deactivatedAt
      ? record.deactivatedAt.toISOString()
      : null,
  };
}

/**
 * CR-HM-SERVICE-CATALOG-01 PART 02 — the VALUE VALIDATION of a variant
 * choice against the attribute it configures.
 *
 * The choice must be admissible for the attribute's data type, and it must
 * be one of the attribute's allowed values unless the attribute explicitly
 * allows a free value. The attribute must belong to the SAME service as the
 * variant ("validasi pilihan terhadap jenis layanan"): a variant may never
 * configure an attribute of another service.
 */
function validateVariantChoice(
  attribute: HandymanServiceAttributeRecord,
  value: { text?: string | null; number?: number | null },
): { valueText: string | null; valueNumber: number | null } {
  if (attribute.dataType === 'NUMBER') {
    const parsed = Number(value.number);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw handymanServiceVariantAttributeInvalidError(
        `Attribute ${attribute.code} is numeric; valueNumber must be a positive number.`,
      );
    }
    if (value.text !== undefined && value.text !== null) {
      throw handymanServiceVariantAttributeInvalidError(
        `Attribute ${attribute.code} is numeric; valueText must be omitted.`,
      );
    }
    return { valueText: null, valueNumber: parsed };
  }

  if (value.number !== undefined && value.number !== null) {
    throw handymanServiceVariantAttributeInvalidError(
      `Attribute ${attribute.code} is not numeric; valueNumber must be omitted.`,
    );
  }
  const text = String(value.text ?? '').trim();
  if (text.length < 1 || text.length > 200) {
    throw handymanServiceVariantAttributeInvalidError(
      `Attribute ${attribute.code} must carry a 1-200 character value.`,
    );
  }
  if (attribute.dataType === 'BOOLEAN' && text !== 'true' && text !== 'false') {
    throw handymanServiceVariantAttributeInvalidError(
      `Attribute ${attribute.code} is boolean; value must be "true" or "false".`,
    );
  }
  if (
    attribute.allowedValues.length > 0 &&
    !attribute.allowFreeValue &&
    !attribute.allowedValues.some((allowed) => allowed.code === text)
  ) {
    throw handymanServiceVariantAttributeInvalidError(
      `Attribute ${attribute.code} value "${text}" is not one of the allowed values.`,
    );
  }
  return { valueText: text, valueNumber: null };
}

/** The variant of one service, proven to belong to that service. */
async function requireVariantOfService(
  serviceCatalogId: string,
  serviceVariantId: string,
  clientId: string,
): Promise<{ id: string; code: string; name: string; status: string }> {
  const variant =
    await handymanParameterizedCatalogRepository.findVariantById(
      undefined,
      serviceVariantId,
    );
  if (
    !variant ||
    variant.clientId !== clientId ||
    variant.serviceCatalogId !== serviceCatalogId
  ) {
    throw handymanServiceVariantNotFoundError();
  }
  const listed =
    await handymanParameterizedCatalogRepository.listVariantsByService(
      undefined,
      clientId,
      serviceCatalogId,
    );
  const found = listed.find((v) => v.id === serviceVariantId);
  if (!found) throw handymanServiceVariantNotFoundError();
  return found;
}

/**
 * The variants of one service with their configured choices.
 *
 * The variant master is the EXISTING `handyman_service_variants` table
 * (0376); the choices are the `handyman_service_variant_attributes` rows.
 */
export type HandymanServiceVariantProjection = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  attributes: PublicHandymanServiceVariantAttribute[];
};

export async function listHandymanServiceVariants(
  serviceCatalogId: string,
  actorUserId: string,
): Promise<HandymanServiceVariantProjection[]> {
  const service = await requireServiceEntry(serviceCatalogId, actorUserId);
  const variants =
    await handymanParameterizedCatalogRepository.listVariantsByService(
      undefined,
      service.clientId,
      service.id,
    );
  const out: HandymanServiceVariantProjection[] = [];
  for (const variant of variants) {
    const attributes =
      await handymanParameterizedCatalogRepository.listVariantAttributes(
        undefined,
        service.clientId,
        variant.id,
      );
    out.push({
      id: variant.id,
      code: variant.code,
      name: variant.name,
      description: variant.description,
      status: variant.status,
      attributes: attributes.map(toPublicVariantAttribute),
    });
  }
  return out;
}

/** The configured choices of ONE variant. */
export async function listHandymanServiceVariantAttributes(
  serviceCatalogId: string,
  serviceVariantId: string,
  actorUserId: string,
  status?: 'ACTIVE' | 'INACTIVE',
): Promise<PublicHandymanServiceVariantAttribute[]> {
  const service = await requireServiceEntry(serviceCatalogId, actorUserId);
  const variant = await requireVariantOfService(
    service.id,
    serviceVariantId,
    service.clientId,
  );
  const attributes =
    await handymanParameterizedCatalogRepository.listVariantAttributes(
      undefined,
      service.clientId,
      variant.id,
      status,
    );
  return attributes.map(toPublicVariantAttribute);
}

export type AddHandymanServiceVariantAttributeInput = {
  attributeId: string;
  valueText?: string | null;
  valueNumber?: number | null;
};

/**
 * Add ONE configured choice to a variant.
 *
 * The (variant, attribute) pair carries exactly ONE choice: a second write
 * for the same pair is refused with 409 instead of overwriting the first
 * one. Editing and retiring are explicit, separate commands.
 */
export async function addHandymanServiceVariantAttribute(
  serviceCatalogId: string,
  serviceVariantId: string,
  input: AddHandymanServiceVariantAttributeInput,
  actorUserId: string,
): Promise<PublicHandymanServiceVariantAttribute> {
  const service = await requireServiceEntry(serviceCatalogId, actorUserId, {
    requireActive: true,
  });
  const variant = await requireVariantOfService(
    service.id,
    serviceVariantId,
    service.clientId,
  );
  if (!isValidUuid(input.attributeId)) {
    throw handymanServiceVariantAttributeInvalidError(
      'attributeId must be a valid UUID.',
    );
  }
  const attribute =
    await handymanParameterizedCatalogRepository.findAttributeById(
      undefined,
      input.attributeId,
    );
  if (
    !attribute ||
    attribute.clientId !== service.clientId ||
    attribute.serviceCatalogId !== service.id
  ) {
    throw handymanServiceVariantAttributeInvalidError(
      'attributeId must reference an attribute of this service.',
    );
  }
  if (attribute.status !== 'ACTIVE') {
    throw handymanServiceVariantAttributeInvalidError(
      'attributeId must reference an ACTIVE attribute.',
    );
  }
  const value = validateVariantChoice(attribute, {
    text: input.valueText ?? null,
    number: input.valueNumber ?? null,
  });

  const existing =
    await handymanParameterizedCatalogRepository.findVariantAttributeByVariantAndAttribute(
      undefined,
      service.clientId,
      variant.id,
      attribute.id,
    );
  if (existing) throw handymanServiceVariantAttributeAlreadyExistsError();

  return withTransaction(async (tx) => {
    const record =
      await handymanParameterizedCatalogRepository.insertVariantAttribute(
        tx as never,
        {
          clientId: service.clientId,
          serviceVariantId: variant.id,
          attributeId: attribute.id,
          valueText: value.valueText,
          valueNumber: value.valueNumber,
          createdByUserId: actorUserId,
        },
      );
    await recordOperationalEvent(
      {
        clientId: service.clientId,
        eventType: 'HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_CREATED',
        entityType: 'HANDYMAN_SERVICE_VARIANT_ATTRIBUTE',
        entityId: record.id,
        actorUserId,
        summary: `Variant ${variant.code} of service ${service.code} now configures attribute ${attribute.code}.`,
        metadata: {
          serviceCatalogId: service.id,
          serviceVariantId: variant.id,
          attributeId: attribute.id,
          attributeCode: attribute.code,
        },
      },
      tx,
    );
    return toPublicVariantAttribute(record);
  });
}

export type UpdateHandymanServiceVariantAttributeInput = {
  valueText?: string | null;
  valueNumber?: number | null;
  status?: 'ACTIVE' | 'INACTIVE';
};

/**
 * Edit OR retire ONE configured choice.
 *
 * Retiring keeps the row (and its value) visible — history is never
 * destroyed — and records WHO retired it and WHEN. Re-activating is the
 * same command with `status: ACTIVE`.
 */
export async function updateHandymanServiceVariantAttribute(
  variantAttributeId: string,
  input: UpdateHandymanServiceVariantAttributeInput,
  actorUserId: string,
): Promise<PublicHandymanServiceVariantAttribute> {
  if (!isValidUuid(variantAttributeId)) {
    throw AppError.validation('Catalog validation failed.', [
      {
        field: 'variantAttributeId',
        message: 'variantAttributeId must be a valid UUID.',
      },
    ]);
  }
  const existing =
    await handymanParameterizedCatalogRepository.findVariantAttributeById(
      undefined,
      variantAttributeId,
    );
  if (!existing) throw handymanServiceVariantAttributeNotFoundError();
  await assertClientAccess(actorUserId, existing.clientId);

  const variant =
    await handymanParameterizedCatalogRepository.findVariantById(
      undefined,
      existing.serviceVariantId,
    );
  if (!variant || variant.clientId !== existing.clientId) {
    throw handymanServiceVariantNotFoundError();
  }
  const attribute =
    await handymanParameterizedCatalogRepository.findAttributeById(
      undefined,
      existing.attributeId,
    );
  if (
    !attribute ||
    attribute.clientId !== existing.clientId ||
    attribute.serviceCatalogId !== variant.serviceCatalogId
  ) {
    throw handymanServiceVariantAttributeInvalidError(
      'The configured choice no longer matches an attribute of this service.',
    );
  }

  const value =
    input.valueText !== undefined || input.valueNumber !== undefined
      ? validateVariantChoice(attribute, {
          text: input.valueText ?? null,
          number: input.valueNumber ?? null,
        })
      : { valueText: existing.valueText, valueNumber: existing.valueNumber };

  const status = input.status ?? existing.status;
  if (status !== 'ACTIVE' && status !== 'INACTIVE') {
    throw handymanServiceVariantAttributeInvalidError(
      'status must be ACTIVE or INACTIVE.',
    );
  }

  return withTransaction(async (tx) => {
    const updated =
      await handymanParameterizedCatalogRepository.updateVariantAttribute(
        tx as never,
        {
          id: existing.id,
          clientId: existing.clientId,
          valueText: value.valueText,
          valueNumber: value.valueNumber,
          status,
          deactivatedByUserId:
            status === 'INACTIVE' ? actorUserId : null,
        },
      );
    if (!updated) throw handymanServiceVariantAttributeNotFoundError();
    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        eventType:
          status === 'INACTIVE'
            ? 'HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_DEACTIVATED'
            : 'HANDYMAN_SERVICE_VARIANT_ATTRIBUTE_UPDATED',
        entityType: 'HANDYMAN_SERVICE_VARIANT_ATTRIBUTE',
        entityId: updated.id,
        actorUserId,
        summary: `Variant ${variant.code} choice for attribute ${attribute.code} ${status === 'INACTIVE' ? 'retired' : 'updated'}.`,
        metadata: {
          serviceCatalogId: variant.serviceCatalogId,
          serviceVariantId: variant.id,
          attributeId: attribute.id,
          attributeCode: attribute.code,
          status,
        },
      },
      tx,
    );
    return toPublicVariantAttribute(updated);
  });
}
