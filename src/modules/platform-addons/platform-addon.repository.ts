import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  AttachSaasAddOnInput,
  CreateSaasAddOnInput,
  ListSaasAddOnFilters,
  SaasAddOnEntitlementEffect,
  SaasAddOnQuotaEffect,
  SaasAddOnRecord,
  SaasAddOnStatus,
  SaasSubscriptionAddOnRecord,
  SaasSubscriptionAddOnStatus,
  UpdateSaasAddOnInput,
} from './platform-addon.types';

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;
function executor(q?: Q): Q {
  return q ?? getPool();
}

const ADDON_SELECT = `
  id,
  product_id      AS "productId",
  code,
  name,
  description,
  status,
  entitlement_effects AS "entitlementEffects",
  quota_effects       AS "quotaEffects",
  created_at      AS "createdAt",
  updated_at      AS "updatedAt"
`;

const BINDING_SELECT = `
  id,
  subscription_id AS "subscriptionId",
  add_on_id       AS "addOnId",
  status,
  created_at      AS "createdAt",
  updated_at      AS "updatedAt"
`;

type AddOnRow = {
  id: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  entitlementEffects: unknown;
  quotaEffects: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type BindingRow = {
  id: string;
  subscriptionId: string;
  addOnId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function parseEffects(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapAddOn(row: AddOnRow): SaasAddOnRecord {
  return {
    id: row.id,
    productId: row.productId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status as SaasAddOnStatus,
    entitlementEffects: parseEffects(
      row.entitlementEffects,
    ) as SaasAddOnEntitlementEffect[],
    quotaEffects: parseEffects(row.quotaEffects) as SaasAddOnQuotaEffect[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapBinding(row: BindingRow): SaasSubscriptionAddOnRecord {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    addOnId: row.addOnId,
    status: row.status as SaasSubscriptionAddOnStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findById(
  id: string,
  q?: Q,
): Promise<SaasAddOnRecord | null> {
  const result = await executor(q).query<AddOnRow>(
    `SELECT ${ADDON_SELECT} FROM product_add_ons WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapAddOn(row) : null;
}

async function findByProductAndCode(
  productId: string,
  code: string,
  q?: Q,
): Promise<SaasAddOnRecord | null> {
  const result = await executor(q).query<AddOnRow>(
    `SELECT ${ADDON_SELECT} FROM product_add_ons
      WHERE product_id = $1 AND code = $2`,
    [productId, code],
  );
  const row = result.rows[0];
  return row ? mapAddOn(row) : null;
}

async function listAll(
  filters: ListSaasAddOnFilters,
  q?: Q,
): Promise<SaasAddOnRecord[]> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (filters.productId !== undefined) {
    values.push(filters.productId);
    sets.push(`product_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    sets.push(`status = $${values.length}`);
  }
  const where = sets.length ? `WHERE ${sets.join(' AND ')}` : '';
  const result = await executor(q).query<AddOnRow>(
    `SELECT ${ADDON_SELECT} FROM product_add_ons
      ${where}
     ORDER BY created_at DESC, id`,
    values,
  );
  return result.rows.map(mapAddOn);
}

async function insert(
  input: CreateSaasAddOnInput,
  q?: Q,
): Promise<SaasAddOnRecord> {
  const result = await executor(q).query<AddOnRow>(
    `INSERT INTO product_add_ons
       (id, product_id, code, name, description, status,
        entitlement_effects, quota_effects)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     RETURNING ${ADDON_SELECT}`,
    [
      randomUUID(),
      input.productId,
      input.code,
      input.name,
      input.description ?? null,
      input.status ?? 'ACTIVE',
      JSON.stringify(input.entitlementEffects ?? []),
      JSON.stringify(input.quotaEffects ?? []),
    ],
  );
  return mapAddOn(result.rows[0]);
}

/**
 * Plain PATCH (PART 13C #6: no catalogue OCC). Only the supplied
 * columns are updated; `updated_at` is the sole revision marker.
 */
async function update(
  id: string,
  patch: UpdateSaasAddOnInput,
  q?: Q,
): Promise<SaasAddOnRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    values.push(patch.name);
    sets.push(`name = $${values.length}`);
  }
  if (patch.description !== undefined) {
    values.push(patch.description);
    sets.push(`description = $${values.length}`);
  }
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (sets.length === 0) {
    return findById(id, q);
  }
  values.push(id);
  sets.push(`updated_at = NOW()`);
  const result = await executor(q).query<AddOnRow>(
    `UPDATE product_add_ons SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ADDON_SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapAddOn(row) : null;
}

async function findActiveBinding(
  subscriptionId: string,
  addOnId: string,
  q?: Q,
): Promise<SaasSubscriptionAddOnRecord | null> {
  const result = await executor(q).query<BindingRow>(
    `SELECT ${BINDING_SELECT} FROM saas_subscription_add_ons
      WHERE subscription_id = $1 AND add_on_id = $2 AND status = 'ACTIVE'`,
    [subscriptionId, addOnId],
  );
  const row = result.rows[0];
  return row ? mapBinding(row) : null;
}

async function insertBinding(
  input: AttachSaasAddOnInput,
  q?: Q,
): Promise<SaasSubscriptionAddOnRecord> {
  const result = await executor(q).query<BindingRow>(
    `INSERT INTO saas_subscription_add_ons
       (id, subscription_id, add_on_id, status)
     VALUES ($1, $2, $3, 'ACTIVE')
     RETURNING ${BINDING_SELECT}`,
    [randomUUID(), input.subscriptionId, input.addOnId],
  );
  return mapBinding(result.rows[0]);
}

async function findBindingById(
  bindingId: string,
  q?: Q,
): Promise<SaasSubscriptionAddOnRecord | null> {
  const result = await executor(q).query<BindingRow>(
    `SELECT ${BINDING_SELECT} FROM saas_subscription_add_ons WHERE id = $1`,
    [bindingId],
  );
  const row = result.rows[0];
  return row ? mapBinding(row) : null;
}

async function markBindingRemoved(
  bindingId: string,
  q?: Q,
): Promise<SaasSubscriptionAddOnRecord | null> {
  const result = await executor(q).query<BindingRow>(
    `UPDATE saas_subscription_add_ons
        SET status = 'REMOVED', updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${BINDING_SELECT}`,
    [bindingId],
  );
  const row = result.rows[0];
  return row ? mapBinding(row) : null;
}

/**
 * Read quota_effects from the add-on catalogue for resolution by the
 * canonical PART 04 limit resolver. PART 13C PART 02 may wire this into
 * a `resolveEffectiveLimit` extension; today the canonical resolver
 * only reads `package_limits` — add-on quota deltas are an
 * outstanding gap (ADDON_QUOTA_SEAM_GAP).
 */
async function readQuotaEffectsForAddOn(
  addOnId: string,
  q?: Q,
): Promise<SaasAddOnQuotaEffect[]> {
  const result = await executor(q).query<{ quotaEffects: unknown }>(
    `SELECT quota_effects AS "quotaEffects"
       FROM product_add_ons WHERE id = $1`,
    [addOnId],
  );
  const raw = result.rows[0]?.quotaEffects;
  return parseEffects(raw) as SaasAddOnQuotaEffect[];
}

async function sumActiveQuotaDeltaForSubscriptionAndKey(
  subscriptionId: string,
  limitKey: string,
  q?: Q,
): Promise<number> {
  // Sum of active SubscriptionAddOn quota_effects matching the
  // capability's package limit key (frozen §12.1 step). Frozen
  // algorithm doesn't read this in PART 04 — exposed here so PART 02
  // can wire it without re-scanning the resolver.
  const result = await executor(q).query<{ sum: string | null }>(
    `SELECT COALESCE(SUM((eff->>'deltaValue')::bigint), 0)::text AS sum
       FROM saas_subscription_add_ons b
       JOIN product_add_ons a ON a.id = b.add_on_id
       CROSS JOIN LATERAL jsonb_array_elements(a.quota_effects) eff
      WHERE b.subscription_id = $1
        AND b.status = 'ACTIVE'
        AND a.status = 'ACTIVE'
        AND (eff->>'limitKey') = $2`,
    [subscriptionId, limitKey],
  );
  return Number(result.rows[0]?.sum ?? '0');
}

export const platformAddOnRepository = {
  findById,
  findByProductAndCode,
  listAll,
  insert,
  update,
  findActiveBinding,
  insertBinding,
  findBindingById,
  markBindingRemoved,
  readQuotaEffectsForAddOn,
  sumActiveQuotaDeltaForSubscriptionAndKey,
};
