import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanServiceAttributeAllowedValue,
  HandymanServiceAttributeDataType,
  HandymanServiceCategoryRecord,
  HandymanServiceCommercialProfileRecord,
  HandymanServicePriceBasis,
  HandymanServicePriceRuleRecord,
  HandymanServicePricingMode,
  HandymanServiceQuoteResolutionRecord,
  HandymanServiceRequestItemRecord,
  HandymanServiceVariantAttributeRecord,
  HandymanServiceAttributeRecord,
} from './handyman-parameterized-catalog.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — parameterized catalogue repository.
 *
 * Executor-first, exactly like the `service-catalog` / `handyman-service-
 * variant` repositories: every function takes an optional executor first so
 * the starter import can run inside ONE transaction. Every read is
 * Client-scoped — `client_id` is a mandatory predicate everywhere, so a
 * row can never leak across the tenant boundary.
 */

type QueryExecutor = Pick<PoolClient, 'query'>;

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

const CATEGORY_SELECT = `
  id, client_id AS "clientId", code, name, description, status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export type NewHandymanServiceCategory = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdByUserId: string;
};

async function insertCategory(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceCategory,
): Promise<HandymanServiceCategoryRecord> {
  const result = await executor.query<HandymanServiceCategoryRecord>(
    `INSERT INTO handyman_service_categories
       (id, client_id, code, name, description, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${CATEGORY_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.status,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

/**
 * Idempotent insert used ONLY by the starter import: an existing row is
 * never overwritten, never updated and never deleted.
 */
async function insertCategoryIfAbsent(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceCategory,
): Promise<{ record: HandymanServiceCategoryRecord; created: boolean }> {
  const result = await executor.query<HandymanServiceCategoryRecord>(
    `INSERT INTO handyman_service_categories
       (id, client_id, code, name, description, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (client_id, code) DO NOTHING
     RETURNING ${CATEGORY_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.status,
      input.createdByUserId,
    ],
  );
  if (result.rows[0]) {
    return { record: result.rows[0], created: true };
  }
  const existing = await findCategoryByCode(
    executor,
    input.clientId,
    input.code,
  );
  if (!existing) {
    throw new Error(
      `Starter import could not resolve category ${input.code} after a skipped insert.`,
    );
  }
  return { record: existing, created: false };
}

async function findCategoryByCode(
  executor: QueryExecutor = getPool(),
  clientId: string,
  code: string,
): Promise<HandymanServiceCategoryRecord | null> {
  const result = await executor.query<HandymanServiceCategoryRecord>(
    `SELECT ${CATEGORY_SELECT} FROM handyman_service_categories
      WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  return result.rows[0] ?? null;
}

async function listCategories(
  executor: QueryExecutor = getPool(),
  clientId: string,
): Promise<HandymanServiceCategoryRecord[]> {
  const result = await executor.query<HandymanServiceCategoryRecord>(
    `SELECT ${CATEGORY_SELECT} FROM handyman_service_categories
      WHERE client_id = $1 ORDER BY code ASC`,
    [clientId],
  );
  return result.rows;
}

/* ------------------------------------------------------------------ */
/* Attribute definitions                                               */
/* ------------------------------------------------------------------ */

const ATTRIBUTE_SELECT = `
  id, client_id AS "clientId", service_catalog_id AS "serviceCatalogId",
  code, name, description, data_type AS "dataType", unit, required,
  allow_free_value AS "allowFreeValue",
  allowed_values AS "allowedValues", sort_order AS "sortOrder", status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export type NewHandymanServiceAttribute = {
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
};

async function insertAttribute(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceAttribute,
): Promise<HandymanServiceAttributeRecord> {
  const result = await executor.query<HandymanServiceAttributeRecord>(
    `INSERT INTO handyman_service_attributes
       (id, client_id, service_catalog_id, code, name, description,
        data_type, unit, required, allow_free_value, allowed_values,
        sort_order, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
     RETURNING ${ATTRIBUTE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.serviceCatalogId,
      input.code,
      input.name,
      input.description,
      input.dataType,
      input.unit,
      input.required,
      input.allowFreeValue,
      JSON.stringify(input.allowedValues),
      input.sortOrder,
      input.status,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function insertAttributeIfAbsent(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceAttribute,
): Promise<{ record: HandymanServiceAttributeRecord; created: boolean }> {
  const result = await executor.query<HandymanServiceAttributeRecord>(
    `INSERT INTO handyman_service_attributes
       (id, client_id, service_catalog_id, code, name, description,
        data_type, unit, required, allow_free_value, allowed_values,
        sort_order, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
     ON CONFLICT (service_catalog_id, code) DO NOTHING
     RETURNING ${ATTRIBUTE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.serviceCatalogId,
      input.code,
      input.name,
      input.description,
      input.dataType,
      input.unit,
      input.required,
      input.allowFreeValue,
      JSON.stringify(input.allowedValues),
      input.sortOrder,
      input.status,
      input.createdByUserId,
    ],
  );
  if (result.rows[0]) {
    return { record: result.rows[0], created: true };
  }
  const existing = await findAttributeByCode(
    executor,
    input.serviceCatalogId,
    input.code,
  );
  if (!existing) {
    throw new Error(
      `Starter import could not resolve attribute ${input.code} after a skipped insert.`,
    );
  }
  return { record: existing, created: false };
}

async function findAttributeById(
  executor: QueryExecutor = getPool(),
  id: string,
): Promise<HandymanServiceAttributeRecord | null> {
  const result = await executor.query<HandymanServiceAttributeRecord>(
    `SELECT ${ATTRIBUTE_SELECT} FROM handyman_service_attributes WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findAttributeByCode(
  executor: QueryExecutor = getPool(),
  serviceCatalogId: string,
  code: string,
): Promise<HandymanServiceAttributeRecord | null> {
  const result = await executor.query<HandymanServiceAttributeRecord>(
    `SELECT ${ATTRIBUTE_SELECT} FROM handyman_service_attributes
      WHERE service_catalog_id = $1 AND code = $2`,
    [serviceCatalogId, code],
  );
  return result.rows[0] ?? null;
}

async function listAttributes(
  executor: QueryExecutor = getPool(),
  clientId: string,
  serviceCatalogId: string,
  status?: 'ACTIVE' | 'INACTIVE',
): Promise<HandymanServiceAttributeRecord[]> {
  const values: unknown[] = [clientId, serviceCatalogId];
  let filter = '';
  if (status !== undefined) {
    values.push(status);
    filter = ' AND status = $3';
  }
  const result = await executor.query<HandymanServiceAttributeRecord>(
    `SELECT ${ATTRIBUTE_SELECT} FROM handyman_service_attributes
      WHERE client_id = $1 AND service_catalog_id = $2${filter}
      ORDER BY sort_order ASC, code ASC`,
    values,
  );
  return result.rows;
}

export type UpdateHandymanServiceAttribute = {
  name?: string;
  description?: string | null;
  unit?: string | null;
  required?: boolean;
  allowFreeValue?: boolean;
  allowedValues?: HandymanServiceAttributeAllowedValue[];
  sortOrder?: number;
  status?: 'ACTIVE' | 'INACTIVE';
};

async function updateAttribute(
  executor: QueryExecutor = getPool(),
  id: string,
  patch: UpdateHandymanServiceAttribute,
): Promise<HandymanServiceAttributeRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.description !== undefined) push('description', patch.description);
  if (patch.unit !== undefined) push('unit', patch.unit);
  if (patch.required !== undefined) push('required', patch.required);
  if (patch.allowFreeValue !== undefined) {
    push('allow_free_value', patch.allowFreeValue);
  }
  if (patch.allowedValues !== undefined) {
    values.push(JSON.stringify(patch.allowedValues));
    sets.push(`allowed_values = $${values.length}::jsonb`);
  }
  if (patch.sortOrder !== undefined) push('sort_order', patch.sortOrder);
  if (patch.status !== undefined) push('status', patch.status);
  if (sets.length === 0) return findAttributeById(executor, id);
  values.push(id);
  const result = await executor.query<HandymanServiceAttributeRecord>(
    `UPDATE handyman_service_attributes
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING ${ATTRIBUTE_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Variant attribute values                                            */
/* ------------------------------------------------------------------ */

const VARIANT_ATTRIBUTE_SELECT = `
  id, client_id AS "clientId", service_variant_id AS "serviceVariantId",
  attribute_id AS "attributeId", value_text AS "valueText",
  value_number::float8 AS "valueNumber", status,
  deactivated_at AS "deactivatedAt",
  deactivated_by_user_id AS "deactivatedByUserId",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export type NewHandymanServiceVariantAttribute = {
  clientId: string;
  serviceVariantId: string;
  attributeId: string;
  valueText: string | null;
  valueNumber: number | null;
  createdByUserId: string;
};

export type UpdateHandymanServiceVariantAttribute = {
  id: string;
  clientId: string;
  valueText: string | null;
  valueNumber: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  /** The actor who retires the choice (null when the row stays ACTIVE). */
  deactivatedByUserId: string | null;
};

/**
 * CR-HM-SERVICE-CATALOG-01 PART 02 — the governed variant-attribute
 * administration writes.
 *
 * `insertVariantAttribute` NEVER overwrites: a (variant, attribute) pair
 * carries exactly ONE choice, so a second write for the same pair is a
 * governance conflict that the service layer refuses with 409. Editing is a
 * separate, explicit command, and retiring a choice is a STATUS change that
 * keeps the row (and its history) visible.
 */
async function insertVariantAttribute(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceVariantAttribute,
): Promise<HandymanServiceVariantAttributeRecord> {
  const result = await executor.query<HandymanServiceVariantAttributeRecord>(
    `INSERT INTO handyman_service_variant_attributes
       (id, client_id, service_variant_id, attribute_id, value_text, value_number,
        status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)
     RETURNING ${VARIANT_ATTRIBUTE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.serviceVariantId,
      input.attributeId,
      input.valueText,
      input.valueNumber,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function updateVariantAttribute(
  executor: QueryExecutor = getPool(),
  input: UpdateHandymanServiceVariantAttribute,
): Promise<HandymanServiceVariantAttributeRecord> {
  const result = await executor.query<HandymanServiceVariantAttributeRecord>(
    `UPDATE handyman_service_variant_attributes
        SET value_text = $3,
            value_number = $4,
            status = $5,
            deactivated_at = CASE WHEN $5 = 'INACTIVE' THEN NOW() ELSE NULL END,
            deactivated_by_user_id = $6,
            updated_at = NOW()
      WHERE id = $1 AND client_id = $2
      RETURNING ${VARIANT_ATTRIBUTE_SELECT}`,
    [
      input.id,
      input.clientId,
      input.valueText,
      input.valueNumber,
      input.status,
      input.deactivatedByUserId,
    ],
  );
  return result.rows[0];
}

async function findVariantAttributeById(
  executor: QueryExecutor = getPool(),
  id: string,
): Promise<HandymanServiceVariantAttributeRecord | null> {
  const result = await executor.query<HandymanServiceVariantAttributeRecord>(
    `SELECT ${VARIANT_ATTRIBUTE_SELECT}
       FROM handyman_service_variant_attributes
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findVariantAttributeByVariantAndAttribute(
  executor: QueryExecutor = getPool(),
  clientId: string,
  serviceVariantId: string,
  attributeId: string,
): Promise<HandymanServiceVariantAttributeRecord | null> {
  const result = await executor.query<HandymanServiceVariantAttributeRecord>(
    `SELECT ${VARIANT_ATTRIBUTE_SELECT}
       FROM handyman_service_variant_attributes
      WHERE client_id = $1 AND service_variant_id = $2 AND attribute_id = $3`,
    [clientId, serviceVariantId, attributeId],
  );
  return result.rows[0] ?? null;
}

async function listVariantAttributes(
  executor: QueryExecutor = getPool(),
  clientId: string,
  serviceVariantId: string,
  status?: 'ACTIVE' | 'INACTIVE',
): Promise<HandymanServiceVariantAttributeRecord[]> {
  const result = await executor.query<HandymanServiceVariantAttributeRecord>(
    `SELECT ${VARIANT_ATTRIBUTE_SELECT}
       FROM handyman_service_variant_attributes
      WHERE client_id = $1 AND service_variant_id = $2
        AND ($3::text IS NULL OR status = $3)
      ORDER BY attribute_id ASC`,
    [clientId, serviceVariantId, status ?? null],
  );
  return result.rows;
}

/**
 * CR-HM-SERVICE-CATALOG-01 PART 03 — the ACTIVE attribute values a variant
 * configures, joined with the attribute DEFINITION so the caller gets the
 * attribute CODE (the governance key) and the lifecycle status of both the
 * choice and the attribute it configures.
 */
async function listVariantAttributeValues(
  executor: QueryExecutor = getPool(),
  clientId: string,
  serviceVariantId: string,
): Promise<
  {
    attributeId: string;
    attributeCode: string;
    attributeStatus: string;
    choiceStatus: string;
    valueText: string | null;
    valueNumber: number | null;
  }[]
> {
  const result = await executor.query<{
    attributeId: string;
    attributeCode: string;
    attributeStatus: string;
    choiceStatus: string;
    valueText: string | null;
    valueNumber: number | null;
  }>(
    `SELECT va.attribute_id AS "attributeId",
            a.code AS "attributeCode",
            a.status AS "attributeStatus",
            va.status AS "choiceStatus",
            va.value_text AS "valueText",
            va.value_number::float8 AS "valueNumber"
       FROM handyman_service_variant_attributes va
       JOIN handyman_service_attributes a ON a.id = va.attribute_id
      WHERE va.client_id = $1 AND va.service_variant_id = $2
      ORDER BY a.code ASC`,
    [clientId, serviceVariantId],
  );
  return result.rows;
}

/**
 * The variants of one service. The variant master is the EXISTING
 * `handyman_service_variants` table (0376) — this module only reads it.
 */
async function listVariantsByService(
  executor: QueryExecutor = getPool(),
  clientId: string,
  serviceCatalogId: string,
): Promise<
  {
    id: string;
    clientId: string;
    serviceCatalogId: string;
    code: string;
    name: string;
    description: string | null;
    status: string;
  }[]
> {
  const result = await executor.query<{
    id: string;
    clientId: string;
    serviceCatalogId: string;
    code: string;
    name: string;
    description: string | null;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId",
            service_catalog_id AS "serviceCatalogId", code, name, description, status
       FROM handyman_service_variants
      WHERE client_id = $1 AND service_catalog_id = $2
      ORDER BY code ASC`,
    [clientId, serviceCatalogId],
  );
  return result.rows;
}

/* ------------------------------------------------------------------ */
/* Commercial profiles                                                 */
/* ------------------------------------------------------------------ */

const COMMERCIAL_PROFILE_SELECT = `
  id, client_id AS "clientId", service_catalog_id AS "serviceCatalogId",
  pricing_mode AS "pricingMode", notes, status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export type NewHandymanServiceCommercialProfile = {
  clientId: string;
  serviceCatalogId: string;
  pricingMode: HandymanServicePricingMode;
  notes: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdByUserId: string;
};

async function upsertCommercialProfile(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceCommercialProfile,
): Promise<HandymanServiceCommercialProfileRecord> {
  const result = await executor.query<HandymanServiceCommercialProfileRecord>(
    `INSERT INTO handyman_service_commercial_profiles
       (id, client_id, service_catalog_id, pricing_mode, notes, status,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (service_catalog_id) DO UPDATE
       SET pricing_mode = EXCLUDED.pricing_mode,
           notes = EXCLUDED.notes,
           status = EXCLUDED.status,
           updated_at = NOW()
     RETURNING ${COMMERCIAL_PROFILE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.serviceCatalogId,
      input.pricingMode,
      input.notes,
      input.status,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findCommercialProfileByService(
  executor: QueryExecutor = getPool(),
  serviceCatalogId: string,
): Promise<HandymanServiceCommercialProfileRecord | null> {
  const result = await executor.query<HandymanServiceCommercialProfileRecord>(
    `SELECT ${COMMERCIAL_PROFILE_SELECT}
       FROM handyman_service_commercial_profiles
      WHERE service_catalog_id = $1`,
    [serviceCatalogId],
  );
  return result.rows[0] ?? null;
}

/**
 * Idempotent commercial-profile insert used ONLY by the starter import: an
 * administrator's configured pricing mode is never overwritten by a later
 * import run.
 */
async function insertCommercialProfileIfAbsent(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceCommercialProfile,
): Promise<{ record: HandymanServiceCommercialProfileRecord; created: boolean }> {
  const result = await executor.query<HandymanServiceCommercialProfileRecord>(
    `INSERT INTO handyman_service_commercial_profiles
       (id, client_id, service_catalog_id, pricing_mode, notes, status,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (service_catalog_id) DO NOTHING
     RETURNING ${COMMERCIAL_PROFILE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.serviceCatalogId,
      input.pricingMode,
      input.notes,
      input.status,
      input.createdByUserId,
    ],
  );
  if (result.rows[0]) {
    return { record: result.rows[0], created: true };
  }
  const existing = await findCommercialProfileByService(
    executor,
    input.serviceCatalogId,
  );
  if (!existing) {
    throw new Error(
      'Starter import could not resolve a commercial profile after a skipped insert.',
    );
  }
  return { record: existing, created: false };
}

/* ------------------------------------------------------------------ */
/* Price rules                                                         */
/* ------------------------------------------------------------------ */

const PRICE_RULE_SELECT = `
  id, client_id AS "clientId", service_catalog_id AS "serviceCatalogId",
  service_variant_id AS "serviceVariantId", rule_code AS "ruleCode",
  price_catalog_entry_id AS "priceCatalogEntryId",
  price_basis AS "priceBasis", attribute_selector AS "attributeSelector",
  min_quantity::float8 AS "minQuantity",
  max_quantity::float8 AS "maxQuantity", status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export type NewHandymanServicePriceRule = {
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
};

async function insertPriceRule(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServicePriceRule,
): Promise<HandymanServicePriceRuleRecord> {
  const result = await executor.query<HandymanServicePriceRuleRecord>(
    `INSERT INTO handyman_service_price_rules
       (id, client_id, service_catalog_id, service_variant_id, rule_code,
        price_catalog_entry_id, price_basis, attribute_selector,
        min_quantity, max_quantity, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
     RETURNING ${PRICE_RULE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.serviceCatalogId,
      input.serviceVariantId,
      input.ruleCode,
      input.priceCatalogEntryId,
      input.priceBasis,
      JSON.stringify(input.attributeSelector),
      input.minQuantity,
      input.maxQuantity,
      input.status,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findPriceRuleById(
  executor: QueryExecutor = getPool(),
  id: string,
): Promise<HandymanServicePriceRuleRecord | null> {
  const result = await executor.query<HandymanServicePriceRuleRecord>(
    `SELECT ${PRICE_RULE_SELECT} FROM handyman_service_price_rules WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findPriceRuleByCode(
  executor: QueryExecutor = getPool(),
  clientId: string,
  ruleCode: string,
): Promise<HandymanServicePriceRuleRecord | null> {
  const result = await executor.query<HandymanServicePriceRuleRecord>(
    `SELECT ${PRICE_RULE_SELECT} FROM handyman_service_price_rules
      WHERE client_id = $1 AND rule_code = $2`,
    [clientId, ruleCode],
  );
  return result.rows[0] ?? null;
}

async function listPriceRules(
  executor: QueryExecutor = getPool(),
  clientId: string,
  serviceCatalogId?: string,
  status?: 'ACTIVE' | 'INACTIVE',
): Promise<HandymanServicePriceRuleRecord[]> {
  const values: unknown[] = [clientId];
  const conditions = ['client_id = $1'];
  if (serviceCatalogId !== undefined) {
    values.push(serviceCatalogId);
    conditions.push(`service_catalog_id = $${values.length}`);
  }
  if (status !== undefined) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  const result = await executor.query<HandymanServicePriceRuleRecord>(
    `SELECT ${PRICE_RULE_SELECT} FROM handyman_service_price_rules
      WHERE ${conditions.join(' AND ')}
      ORDER BY service_catalog_id ASC, rule_code ASC`,
    values,
  );
  return result.rows;
}

export type UpdateHandymanServicePriceRule = {
  serviceVariantId?: string | null;
  priceCatalogEntryId?: string;
  priceBasis?: HandymanServicePriceBasis;
  attributeSelector?: Record<string, string>;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  status?: 'ACTIVE' | 'INACTIVE';
};

async function updatePriceRule(
  executor: QueryExecutor = getPool(),
  id: string,
  patch: UpdateHandymanServicePriceRule,
): Promise<HandymanServicePriceRuleRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.serviceVariantId !== undefined) {
    push('service_variant_id', patch.serviceVariantId);
  }
  if (patch.priceCatalogEntryId !== undefined) {
    push('price_catalog_entry_id', patch.priceCatalogEntryId);
  }
  if (patch.priceBasis !== undefined) push('price_basis', patch.priceBasis);
  if (patch.attributeSelector !== undefined) {
    values.push(JSON.stringify(patch.attributeSelector));
    sets.push(`attribute_selector = $${values.length}::jsonb`);
  }
  if (patch.minQuantity !== undefined) push('min_quantity', patch.minQuantity);
  if (patch.maxQuantity !== undefined) push('max_quantity', patch.maxQuantity);
  if (patch.status !== undefined) push('status', patch.status);
  if (sets.length === 0) return findPriceRuleById(executor, id);
  values.push(id);
  const result = await executor.query<HandymanServicePriceRuleRecord>(
    `UPDATE handyman_service_price_rules
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING ${PRICE_RULE_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Request items                                                       */
/* ------------------------------------------------------------------ */

const REQUEST_ITEM_SELECT = `
  id, client_id AS "clientId", handyman_request_id AS "handymanRequestId",
  service_catalog_id AS "serviceCatalogId",
  service_variant_id AS "serviceVariantId", quantity::float8 AS quantity,
  uom_id AS "uomId", item_description AS "itemDescription",
  attribute_values AS "attributeValues",
  inherited_attribute_values AS "inheritedAttributeValues",
  access_condition AS "accessCondition", status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export type NewHandymanServiceRequestItem = {
  clientId: string;
  handymanRequestId: string;
  serviceCatalogId: string;
  serviceVariantId: string | null;
  quantity: number;
  /** The REPORTED unit of measure (existing units_of_measure master). */
  uomId?: string | null;
  /** The bounded per-item free-text note (1-1000, service-validated). */
  itemDescription?: string | null;
  attributeValues: Record<string, string>;
  /** The provenance: the values the variant supplied. */
  inheritedAttributeValues: Record<string, string>;
  accessCondition: string;
  status: 'ACTIVE' | 'REMOVED';
  createdByUserId: string;
};

async function insertRequestItem(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceRequestItem,
): Promise<HandymanServiceRequestItemRecord> {
  const result = await executor.query<HandymanServiceRequestItemRecord>(
    `INSERT INTO handyman_service_request_items
       (id, client_id, handyman_request_id, service_catalog_id,
        service_variant_id, quantity, uom_id, item_description,
        attribute_values, inherited_attribute_values, access_condition,
        status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13)
     RETURNING ${REQUEST_ITEM_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanRequestId,
      input.serviceCatalogId,
      input.serviceVariantId,
      input.quantity,
      input.uomId ?? null,
      input.itemDescription ?? null,
      JSON.stringify(input.attributeValues),
      JSON.stringify(input.inheritedAttributeValues),
      input.accessCondition,
      input.status,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findRequestItemById(
  executor: QueryExecutor = getPool(),
  id: string,
): Promise<HandymanServiceRequestItemRecord | null> {
  const result = await executor.query<HandymanServiceRequestItemRecord>(
    `SELECT ${REQUEST_ITEM_SELECT} FROM handyman_service_request_items
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listRequestItems(
  executor: QueryExecutor = getPool(),
  clientId: string,
  handymanRequestId: string,
  status?: 'ACTIVE' | 'REMOVED',
): Promise<HandymanServiceRequestItemRecord[]> {
  const values: unknown[] = [clientId, handymanRequestId];
  let filter = '';
  if (status !== undefined) {
    values.push(status);
    filter = ` AND status = $${values.length}`;
  }
  const result = await executor.query<HandymanServiceRequestItemRecord>(
    `SELECT ${REQUEST_ITEM_SELECT} FROM handyman_service_request_items
      WHERE client_id = $1 AND handyman_request_id = $2${filter}
      ORDER BY created_at ASC, id ASC`,
    values,
  );
  return result.rows;
}

export type UpdateHandymanServiceRequestItem = {
  serviceVariantId?: string | null;
  quantity?: number;
  /** The REPORTED unit of measure (existing units_of_measure master). */
  uomId?: string | null;
  /** The bounded per-item free-text note. */
  itemDescription?: string | null;
  attributeValues?: Record<string, string>;
  /** The provenance: the values the variant supplied. */
  inheritedAttributeValues?: Record<string, string>;
  accessCondition?: string;
  status?: 'ACTIVE' | 'REMOVED';
};

async function updateRequestItem(
  executor: QueryExecutor = getPool(),
  id: string,
  patch: UpdateHandymanServiceRequestItem,
): Promise<HandymanServiceRequestItemRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.serviceVariantId !== undefined) {
    push('service_variant_id', patch.serviceVariantId);
  }
  if (patch.quantity !== undefined) push('quantity', patch.quantity);
  if (patch.uomId !== undefined) push('uom_id', patch.uomId);
  if (patch.itemDescription !== undefined) {
    push('item_description', patch.itemDescription);
  }
  if (patch.attributeValues !== undefined) {
    values.push(JSON.stringify(patch.attributeValues));
    sets.push(`attribute_values = $${values.length}::jsonb`);
  }
  if (patch.inheritedAttributeValues !== undefined) {
    values.push(JSON.stringify(patch.inheritedAttributeValues));
    sets.push(`inherited_attribute_values = $${values.length}::jsonb`);
  }
  if (patch.accessCondition !== undefined) {
    push('access_condition', patch.accessCondition);
  }
  if (patch.status !== undefined) push('status', patch.status);
  if (sets.length === 0) return findRequestItemById(executor, id);
  values.push(id);
  const result = await executor.query<HandymanServiceRequestItemRecord>(
    `UPDATE handyman_service_request_items
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING ${REQUEST_ITEM_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Quote resolutions (append-only price snapshot)                      */
/* ------------------------------------------------------------------ */

const RESOLUTION_SELECT = `
  id, client_id AS "clientId", handyman_request_id AS "handymanRequestId",
  request_item_id AS "requestItemId", outcome, reason_code AS "reasonCode",
  reason_detail AS "reasonDetail", price_rule_id AS "priceRuleId",
  price_catalog_entry_id AS "priceCatalogEntryId", currency,
  unit_amount::float8 AS "unitAmount",
  quantity::float8 AS quantity,
  price_basis AS "priceBasis",
  effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
  computed_total::float8 AS "computedTotal",
  quotation_id AS "quotationId",
  quotation_version_id AS "quotationVersionId",
  quotation_line_id AS "quotationLineId",
  resolved_by_user_id AS "resolvedByUserId", created_at AS "createdAt"
`;

export type NewHandymanServiceQuoteResolution = {
  clientId: string;
  handymanRequestId: string;
  requestItemId: string | null;
  outcome: 'PRICED' | 'INSPECTION_REQUIRED' | 'MANUAL_REVIEW';
  reasonCode: string;
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
};

async function insertResolution(
  executor: QueryExecutor = getPool(),
  input: NewHandymanServiceQuoteResolution,
): Promise<HandymanServiceQuoteResolutionRecord> {
  const result = await executor.query<HandymanServiceQuoteResolutionRecord>(
    `INSERT INTO handyman_service_quote_resolutions
       (id, client_id, handyman_request_id, request_item_id, outcome,
        reason_code, reason_detail, price_rule_id, price_catalog_entry_id,
        currency, unit_amount, quantity, price_basis, effective_from,
        effective_to, computed_total, quotation_id, quotation_version_id,
        quotation_line_id, resolved_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20)
     RETURNING ${RESOLUTION_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanRequestId,
      input.requestItemId,
      input.outcome,
      input.reasonCode,
      input.reasonDetail,
      input.priceRuleId,
      input.priceCatalogEntryId,
      input.currency,
      input.unitAmount,
      input.quantity,
      input.priceBasis,
      input.effectiveFrom,
      input.effectiveTo,
      input.computedTotal,
      input.quotationId,
      input.quotationVersionId,
      input.quotationLineId,
      input.resolvedByUserId,
    ],
  );
  return result.rows[0];
}

async function listResolutions(
  executor: QueryExecutor = getPool(),
  clientId: string,
  handymanRequestId: string,
): Promise<HandymanServiceQuoteResolutionRecord[]> {
  const result = await executor.query<HandymanServiceQuoteResolutionRecord>(
    `SELECT ${RESOLUTION_SELECT} FROM handyman_service_quote_resolutions
      WHERE client_id = $1 AND handyman_request_id = $2
      ORDER BY created_at ASC, id ASC`,
    [clientId, handymanRequestId],
  );
  return result.rows;
}

/* ------------------------------------------------------------------ */
/* Existing masters — idempotent inserts used by the starter import    */
/* ------------------------------------------------------------------ */

/**
 * The EXISTING `service_catalog` master (migration 0321) is the only
 * authoritative Service identity. The starter import therefore INSERTS into
 * that master; it never invents a second service table. The insert is
 * idempotent (`ON CONFLICT (client_id, code) DO NOTHING`) so a re-run never
 * overwrites an administrator's existing entry.
 */
async function insertServiceCatalogIfAbsent(
  executor: QueryExecutor = getPool(),
  input: {
    clientId: string;
    code: string;
    name: string;
    description: string | null;
    category: string;
    createdByUserId: string;
  },
): Promise<{ id: string; created: boolean }> {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO service_catalog
       (id, client_id, code, name, description, category, status,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)
     ON CONFLICT (client_id, code) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.category,
      input.createdByUserId,
    ],
  );
  if (result.rows[0]) {
    return { id: result.rows[0].id, created: true };
  }
  const existing = await executor.query<{ id: string }>(
    `SELECT id FROM service_catalog WHERE client_id = $1 AND code = $2`,
    [input.clientId, input.code],
  );
  if (!existing.rows[0]) {
    throw new Error(
      `Starter import could not resolve service ${input.code} after a skipped insert.`,
    );
  }
  return { id: existing.rows[0].id, created: false };
}

/**
 * The EXISTING `handyman_service_variants` master (migration 0376) is the
 * Handyman variant identity. Same idempotent insert rule as above.
 */
async function insertVariantIfAbsent(
  executor: QueryExecutor = getPool(),
  input: {
    clientId: string;
    serviceCatalogId: string;
    code: string;
    name: string;
    description: string | null;
    createdByUserId: string;
  },
): Promise<{ id: string; created: boolean }> {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO handyman_service_variants
       (id, client_id, service_catalog_id, code, name, description, status,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)
     ON CONFLICT (service_catalog_id, code) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.clientId,
      input.serviceCatalogId,
      input.code,
      input.name,
      input.description,
      input.createdByUserId,
    ],
  );
  if (result.rows[0]) {
    return { id: result.rows[0].id, created: true };
  }
  const existing = await executor.query<{ id: string }>(
    `SELECT id FROM handyman_service_variants
      WHERE service_catalog_id = $1 AND code = $2`,
    [input.serviceCatalogId, input.code],
  );
  if (!existing.rows[0]) {
    throw new Error(
      `Starter import could not resolve variant ${input.code} after a skipped insert.`,
    );
  }
  return { id: existing.rows[0].id, created: false };
}

/**
 * The EXISTING `units_of_measure` master (migration 0071) carries the
 * quantity UOM each price basis counts in. Same idempotent insert rule.
 */
async function insertUnitOfMeasureIfAbsent(
  executor: QueryExecutor = getPool(),
  input: {
    clientId: string;
    code: string;
    name: string;
    symbol: string;
    category: string;
  },
): Promise<{ id: string; created: boolean }> {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO units_of_measure
       (id, client_id, code, name, symbol, category, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
     ON CONFLICT (client_id, code) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.symbol,
      input.category,
    ],
  );
  if (result.rows[0]) {
    return { id: result.rows[0].id, created: true };
  }
  const existing = await executor.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE client_id = $1 AND code = $2`,
    [input.clientId, input.code],
  );
  if (!existing.rows[0]) {
    throw new Error(
      `Starter import could not resolve UOM ${input.code} after a skipped insert.`,
    );
  }
  return { id: existing.rows[0].id, created: false };
}

async function findUnitOfMeasureByCode(
  executor: QueryExecutor = getPool(),
  clientId: string,
  code: string,
): Promise<{ id: string } | null> {
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM units_of_measure WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  return result.rows[0] ?? null;
}

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — Client-scoped UOM membership for a
 * REPORTED item uom (same `units_of_measure master of this client` idiom as
 * the quotation-line engine). Returns the row's status so the service can
 * also refuse a retired (INACTIVE) unit.
 */
async function findUnitOfMeasureForClient(
  executor: QueryExecutor = getPool(),
  uomId: string,
  clientId: string,
): Promise<{ id: string; status: string } | null> {
  const result = await executor.query<{ id: string; status: string }>(
    `SELECT id, status FROM units_of_measure WHERE id = $1 AND client_id = $2`,
    [uomId, clientId],
  );
  return result.rows[0] ?? null;
}

/**
 * The EXISTING `handyman_service_variants` master (migration 0376) — read
 * so a request item can prove its variant belongs to its service.
 */
async function findVariantById(
  executor: QueryExecutor = getPool(),
  id: string,
): Promise<{
  id: string;
  clientId: string;
  serviceCatalogId: string;
  code: string;
  name: string;
  status: string;
} | null> {
  const result = await executor.query<{
    id: string;
    clientId: string;
    serviceCatalogId: string;
    code: string;
    name: string;
    status: string;
  }>(
    `SELECT id, client_id AS "clientId",
            service_catalog_id AS "serviceCatalogId", code, name, status
       FROM handyman_service_variants
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * The EXISTING pricing authority row (`price_catalog_entries`, SERVICE
 * mode). The price rule only points at it — it never owns an amount.
 */
export type HandymanPriceCatalogEntrySnapshot = {
  id: string;
  clientId: string;
  sourceMode: string;
  serviceId: string | null;
  /**
   * CR-HM-SERVICE-CATALOG-01 PART 01 — the catalogue price tier key of the
   * SERVICE reference price ('' = the plain service reference price).
   */
  servicePriceKey: string | null;
  currency: string;
  unitPrice: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: string;
  buildingId: string | null;
};

async function findPriceCatalogEntryById(
  executor: QueryExecutor = getPool(),
  id: string,
): Promise<HandymanPriceCatalogEntrySnapshot | null> {
  const result = await executor.query<HandymanPriceCatalogEntrySnapshot>(
    `SELECT id, client_id AS "clientId", source_mode AS "sourceMode",
            service_id AS "serviceId",
            service_price_key AS "servicePriceKey", currency,
            unit_price AS "unitPrice", effective_from AS "effectiveFrom",
            effective_to AS "effectiveTo", status,
            building_id AS "buildingId"
       FROM price_catalog_entries
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const handymanParameterizedCatalogRepository = {
  insertCategory,
  insertCategoryIfAbsent,
  findCategoryByCode,
  listCategories,
  insertAttribute,
  insertAttributeIfAbsent,
  findAttributeById,
  findAttributeByCode,
  listAttributes,
  updateAttribute,
  insertVariantAttribute,
  updateVariantAttribute,
  findVariantAttributeById,
  findVariantAttributeByVariantAndAttribute,
  listVariantAttributes,
  listVariantAttributeValues,
  listVariantsByService,
  upsertCommercialProfile,
  insertCommercialProfileIfAbsent,
  findCommercialProfileByService,
  insertPriceRule,
  findPriceRuleById,
  findPriceRuleByCode,
  listPriceRules,
  updatePriceRule,
  insertRequestItem,
  findRequestItemById,
  listRequestItems,
  updateRequestItem,
  insertResolution,
  listResolutions,
  insertServiceCatalogIfAbsent,
  insertVariantIfAbsent,
  insertUnitOfMeasureIfAbsent,
  findUnitOfMeasureByCode,
  findUnitOfMeasureForClient,
  findVariantById,
  findPriceCatalogEntryById,
};
