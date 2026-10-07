import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CreateSaasPackageInput,
  CreateSaasProductInput,
  FrozenPackageLimitKey,
  ListSaasPackageFilters,
  ListSaasProductFilters,
  PackageFeatureRecord,
  PackageLimitRecord,
  SaasPackageDetail,
  SaasPackageRecord,
  SaasProductRecord,
  UpdateSaasProductInput,
} from './platform-product.types';

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;
function executor(q?: Q): Q {
  return q ?? getPool();
}

type ProductRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type PackageRow = {
  id: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type FeatureRow = {
  id: string;
  package_id: string;
  capability_code: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

type LimitRow = {
  id: string;
  package_id: string;
  limit_key: string;
  limit_value: string;
  unit: string;
  created_at: Date;
  updated_at: Date;
};

const PRODUCT_SELECT = `
  id, code, name, description, status,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
const PACKAGE_SELECT = `
  id, product_id AS "productId", code, name, description, status,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

function mapProduct(row: ProductRow): SaasProductRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status as SaasProductRecord['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPackage(row: PackageRow): SaasPackageRecord {
  return {
    id: row.id,
    productId: row.productId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status as SaasPackageRecord['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapFeature(row: FeatureRow): PackageFeatureRecord {
  return {
    id: row.id,
    packageId: row.package_id,
    capabilityCode: row.capability_code,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLimit(row: LimitRow): PackageLimitRecord {
  return {
    id: row.id,
    packageId: row.package_id,
    limitKey: row.limit_key as FrozenPackageLimitKey,
    limitValue: Number(row.limit_value),
    unit: row.unit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createProduct(
  input: CreateSaasProductInput,
  q?: Q,
): Promise<SaasProductRecord> {
  const result = await executor(q).query<ProductRow>(
    `INSERT INTO saas_products (id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PRODUCT_SELECT}`,
    [
      randomUUID(),
      input.code,
      input.name,
      input.description ?? null,
      input.status ?? 'ACTIVE',
    ],
  );
  return mapProduct(result.rows[0]);
}

async function findProductById(
  id: string,
  q?: Q,
): Promise<SaasProductRecord | null> {
  const result = await executor(q).query<ProductRow>(
    `SELECT ${PRODUCT_SELECT} FROM saas_products WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapProduct(row) : null;
}

async function findProductByCode(
  code: string,
  q?: Q,
): Promise<SaasProductRecord | null> {
  const result = await executor(q).query<ProductRow>(
    `SELECT ${PRODUCT_SELECT} FROM saas_products WHERE code = $1`,
    [code],
  );
  const row = result.rows[0];
  return row ? mapProduct(row) : null;
}

async function listProducts(
  filters: ListSaasProductFilters,
  withTotal: boolean,
  limit?: number,
  offset?: number,
  q?: Q,
): Promise<{ records: SaasProductRecord[]; total: number | null }> {
  const db = executor(q);
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  let total: number | null = null;
  if (withTotal) {
    const countResult = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM saas_products ${where}`,
      values,
    );
    total = countResult.rows[0]?.total ?? 0;
  }

  // LIMIT/OFFSET parameter positions are derived from the filter value
  // count, not from the assembled array length (offset may be absent).
  const limitPos = values.length + 1;
  const offsetPos = values.length + 2;
  const listParams = [
    ...values,
    ...(limit !== undefined ? [limit] : []),
    ...(offset !== undefined ? [offset] : []),
  ];
  const limitClause = limit !== undefined ? `LIMIT $${limitPos}` : '';
  const offsetClause = offset !== undefined ? `OFFSET $${offsetPos}` : '';
  const result = await db.query<ProductRow>(
    `SELECT ${PRODUCT_SELECT} FROM saas_products ${where}
      ORDER BY created_at DESC, id DESC
      ${limitClause} ${offsetClause}`,
    listParams,
  );
  return { records: result.rows.map(mapProduct), total };
}

async function updateProduct(
  id: string,
  input: UpdateSaasProductInput,
  q?: Q,
): Promise<SaasProductRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }
  if (sets.length === 0) return findProductById(id, q);
  const result = await executor(q).query<ProductRow>(
    `UPDATE saas_products SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING ${PRODUCT_SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapProduct(row) : null;
}

async function createPackage(
  input: CreateSaasPackageInput,
  q?: Q,
): Promise<SaasPackageRecord> {
  const result = await executor(q).query<PackageRow>(
    `INSERT INTO saas_packages (id, product_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${PACKAGE_SELECT}`,
    [
      randomUUID(),
      input.productId,
      input.code,
      input.name,
      input.description ?? null,
      input.status ?? 'ACTIVE',
    ],
  );
  return mapPackage(result.rows[0]);
}

async function findPackageById(
  id: string,
  q?: Q,
): Promise<SaasPackageRecord | null> {
  const result = await executor(q).query<PackageRow>(
    `SELECT ${PACKAGE_SELECT} FROM saas_packages WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapPackage(row) : null;
}

async function findPackageByProductAndCode(
  productId: string,
  code: string,
  q?: Q,
): Promise<SaasPackageRecord | null> {
  const result = await executor(q).query<PackageRow>(
    `SELECT ${PACKAGE_SELECT} FROM saas_packages
      WHERE product_id = $1 AND code = $2`,
    [productId, code],
  );
  const row = result.rows[0];
  return row ? mapPackage(row) : null;
}

async function listPackages(
  filters: ListSaasPackageFilters,
  withTotal: boolean,
  limit?: number,
  offset?: number,
  q?: Q,
): Promise<{ records: SaasPackageRecord[]; total: number | null }> {
  const db = executor(q);
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.productId !== undefined) {
    values.push(filters.productId);
    clauses.push(`product_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  let total: number | null = null;
  if (withTotal) {
    const countResult = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM saas_packages ${where}`,
      values,
    );
    total = countResult.rows[0]?.total ?? 0;
  }

  const listParams = [
    ...values,
    ...(limit !== undefined ? [limit] : []),
    ...(offset !== undefined ? [offset] : []),
  ];
  const limitPos = values.length + 1;
  const offsetPos = values.length + 2;
  const limitClause = limit !== undefined ? `LIMIT $${limitPos}` : '';
  const offsetClause = offset !== undefined ? `OFFSET $${offsetPos}` : '';
  const result = await db.query<PackageRow>(
    `SELECT ${PACKAGE_SELECT} FROM saas_packages ${where}
      ORDER BY created_at DESC, id DESC
      ${limitClause} ${offsetClause}`,
    listParams,
  );
  return { records: result.rows.map(mapPackage), total };
}

async function updatePackageScalars(
  id: string,
  input: {
    name?: string;
    description?: string | null;
    status?: string;
  },
  q?: Q,
): Promise<SaasPackageRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }
  if (sets.length === 0) return findPackageById(id, q);
  const result = await executor(q).query<PackageRow>(
    `UPDATE saas_packages SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING ${PACKAGE_SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapPackage(row) : null;
}

async function insertFeatures(
  packageId: string,
  features: ReadonlyArray<{ capabilityCode: string; enabled: boolean }>,
  q?: Q,
): Promise<PackageFeatureRecord[]> {
  if (features.length === 0) return [];
  const db = executor(q);
  const records: PackageFeatureRecord[] = [];
  for (const feature of features) {
    const result = await db.query<FeatureRow>(
      `INSERT INTO package_features (id, package_id, capability_code, enabled)
       VALUES ($1, $2, $3, $4)
       RETURNING id, package_id AS "package_id", capability_code, enabled,
                 created_at, updated_at`,
      [randomUUID(), packageId, feature.capabilityCode, feature.enabled],
    );
    records.push(mapFeature(result.rows[0]));
  }
  return records;
}

async function insertLimits(
  packageId: string,
  limits: ReadonlyArray<{
    limitKey: FrozenPackageLimitKey;
    limitValue: number;
    unit: string;
  }>,
  q?: Q,
): Promise<PackageLimitRecord[]> {
  if (limits.length === 0) return [];
  const db = executor(q);
  const records: PackageLimitRecord[] = [];
  for (const limit of limits) {
    const result = await db.query<LimitRow>(
      `INSERT INTO package_limits (id, package_id, limit_key, limit_value, unit)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, package_id AS "package_id", limit_key, limit_value,
                 unit, created_at, updated_at`,
      [randomUUID(), packageId, limit.limitKey, limit.limitValue, limit.unit],
    );
    records.push(mapLimit(result.rows[0]));
  }
  return records;
}

/** Replaces all features/limits of a package (atomic with the caller). */
async function replacePackageComposition(
  packageId: string,
  features: ReadonlyArray<{ capabilityCode: string; enabled: boolean }>,
  limits: ReadonlyArray<{
    limitKey: FrozenPackageLimitKey;
    limitValue: number;
    unit: string;
  }>,
  q?: Q,
): Promise<{ features: PackageFeatureRecord[]; limits: PackageLimitRecord[] }> {
  const db = executor(q);
  await db.query(`DELETE FROM package_features WHERE package_id = $1`, [
    packageId,
  ]);
  await db.query(`DELETE FROM package_limits WHERE package_id = $1`, [
    packageId,
  ]);
  const insertedFeatures = await insertFeatures(packageId, features, db);
  const insertedLimits = await insertLimits(packageId, limits, db);
  return { features: insertedFeatures, limits: insertedLimits };
}

async function findFeaturesByPackageId(
  packageId: string,
  q?: Q,
): Promise<PackageFeatureRecord[]> {
  const result = await executor(q).query<FeatureRow>(
    `SELECT id, package_id AS "package_id", capability_code, enabled,
            created_at, updated_at
       FROM package_features
      WHERE package_id = $1
      ORDER BY capability_code ASC`,
    [packageId],
  );
  return result.rows.map(mapFeature);
}

async function findLimitsByPackageId(
  packageId: string,
  q?: Q,
): Promise<PackageLimitRecord[]> {
  const result = await executor(q).query<LimitRow>(
    `SELECT id, package_id AS "package_id", limit_key, limit_value,
            unit, created_at, updated_at
       FROM package_limits
      WHERE package_id = $1
      ORDER BY limit_key ASC`,
    [packageId],
  );
  return result.rows.map(mapLimit);
}

async function findPackagesByProductId(
  productId: string,
  q?: Q,
): Promise<SaasPackageRecord[]> {
  const result = await executor(q).query<PackageRow>(
    `SELECT ${PACKAGE_SELECT} FROM saas_packages
      WHERE product_id = $1
      ORDER BY code ASC`,
    [productId],
  );
  return result.rows.map(mapPackage);
}

async function findPackageDetail(
  id: string,
  q?: Q,
): Promise<SaasPackageDetail | null> {
  const db = executor(q);
  const packageRecord = await findPackageById(id, db);
  if (!packageRecord) return null;
  const features = await findFeaturesByPackageId(id, db);
  const limits = await findLimitsByPackageId(id, db);
  return { ...packageRecord, features, limits };
}

export const platformProductRepository = {
  createProduct,
  findProductById,
  findProductByCode,
  listProducts,
  updateProduct,
  createPackage,
  findPackageById,
  findPackageByProductAndCode,
  listPackages,
  updatePackageScalars,
  insertFeatures,
  insertLimits,
  replacePackageComposition,
  findFeaturesByPackageId,
  findLimitsByPackageId,
  findPackagesByProductId,
  findPackageDetail,
};
