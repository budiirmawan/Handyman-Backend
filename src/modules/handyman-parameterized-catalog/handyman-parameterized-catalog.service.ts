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
  handymanServicePriceRuleInvalidError,
  handymanServicePriceRuleNotFoundError,
} from './handyman-parameterized-catalog.errors';
import {
  isHandymanServiceAttributeDataType,
  isHandymanServicePriceBasis,
  isHandymanServicePricingMode,
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
    out[code] = value.trim();
  }
  return out;
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
  // CR-HM-SERVICE-CATALOG-01 PART 01 — the catalogue PRICE TIER of the price
  // fact must be coherent with the rule that consumes it: the plain service
  // reference price ('') is usable by any rule, and a tiered price must
  // carry exactly this rule's code as its tier key. A rule can therefore
  // never silently consume another tier's amount.
  const priceKey = entry.servicePriceKey ?? '';
  if (priceKey !== '' && priceKey !== ruleCode) {
    throw handymanServicePriceRuleInvalidError(
      `The referenced price fills the catalogue price tier "${priceKey}"; only a rule with that code may consume it.`,
    );
  }

  // The selector may only reference attribute definitions that actually
  // exist for this service — otherwise the rule could never match and would
  // silently price nothing.
  const attributes = await handymanParameterizedCatalogRepository.listAttributes(
    undefined,
    service.clientId,
    service.id,
  );
  const knownCodes = new Set(attributes.map((a) => a.code));
  for (const code of Object.keys(attributeSelector)) {
    if (!knownCodes.has(code)) {
      throw handymanServicePriceRuleInvalidError(
        `attributeSelector references an unknown attribute code: ${code}.`,
      );
    }
  }

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
    const priceKey = entry.servicePriceKey ?? '';
    if (priceKey !== '' && priceKey !== existing.ruleCode) {
      throw handymanServicePriceRuleInvalidError(
        `The referenced price fills the catalogue price tier "${priceKey}"; only a rule with that code may consume it.`,
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
