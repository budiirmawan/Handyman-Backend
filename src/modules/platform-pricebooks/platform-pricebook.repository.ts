import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CreateSaasPricebookInput,
  ListSaasPricebookFilters,
  NormalizedPriceItem,
  SaasPricebookRecord,
  SaasPricebookVersionRecord,
  SaasPriceItemRecord,
} from './platform-pricebook.types';

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<PoolClient, 'query'> | ReturnType<typeof getPool>;
function executor(q?: Q): Q {
  return q ?? getPool();
}

type PricebookRow = {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type VersionRow = {
  id: string;
  pricebookId: string;
  versionNumber: number;
  status: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ItemRow = {
  id: string;
  pricebookVersionId: string;
  productId: string;
  packageId: string | null;
  currencyCode: string;
  billingCycle: string;
  basePrice: string;
  includedBuildingCount: number;
  additionalBuildingPrice: string;
  createdAt: Date;
  updatedAt: Date;
};

const PRICEBOOK_SELECT = `
  id, code, name, currency_code AS "currencyCode", status,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
const VERSION_SELECT = `
  id, pricebook_id AS "pricebookId", version_number AS "versionNumber",
  status, effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
  published_at AS "publishedAt", published_by_user_id AS "publishedByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
const ITEM_SELECT = `
  id, pricebook_version_id AS "pricebookVersionId",
  product_id AS "productId", package_id AS "packageId",
  currency_code AS "currencyCode", billing_cycle AS "billingCycle",
  base_price AS "basePrice",
  included_building_count AS "includedBuildingCount",
  additional_building_price AS "additionalBuildingPrice",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

function mapPricebook(row: PricebookRow): SaasPricebookRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    currencyCode: row.currencyCode,
    status: row.status as SaasPricebookRecord['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapVersion(row: VersionRow): SaasPricebookVersionRecord {
  return {
    id: row.id,
    pricebookId: row.pricebookId,
    versionNumber: row.versionNumber,
    status: row.status as SaasPricebookVersionRecord['status'],
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    publishedAt: row.publishedAt,
    publishedByUserId: row.publishedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapItem(row: ItemRow): SaasPriceItemRecord {
  return {
    id: row.id,
    pricebookVersionId: row.pricebookVersionId,
    productId: row.productId,
    packageId: row.packageId,
    currencyCode: row.currencyCode,
    billingCycle: row.billingCycle as SaasPriceItemRecord['billingCycle'],
    basePrice: Number(row.basePrice),
    includedBuildingCount: row.includedBuildingCount,
    additionalBuildingPrice: Number(row.additionalBuildingPrice),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createPricebook(
  input: CreateSaasPricebookInput,
  q?: Q,
): Promise<SaasPricebookRecord> {
  const result = await executor(q).query<PricebookRow>(
    `INSERT INTO saas_pricebooks (id, code, name, currency_code, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PRICEBOOK_SELECT}`,
    [
      randomUUID(),
      input.code,
      input.name,
      input.currencyCode,
      input.status ?? 'ACTIVE',
    ],
  );
  return mapPricebook(result.rows[0]);
}

async function findPricebookById(
  id: string,
  q?: Q,
): Promise<SaasPricebookRecord | null> {
  const result = await executor(q).query<PricebookRow>(
    `SELECT ${PRICEBOOK_SELECT} FROM saas_pricebooks WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapPricebook(row) : null;
}

async function findPricebookByCode(
  code: string,
  q?: Q,
): Promise<SaasPricebookRecord | null> {
  const result = await executor(q).query<PricebookRow>(
    `SELECT ${PRICEBOOK_SELECT} FROM saas_pricebooks WHERE code = $1`,
    [code],
  );
  const row = result.rows[0];
  return row ? mapPricebook(row) : null;
}

async function listPricebooks(
  filters: ListSaasPricebookFilters,
  withTotal: boolean,
  limit?: number,
  offset?: number,
  q?: Q,
): Promise<{ records: SaasPricebookRecord[]; total: number | null }> {
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
      `SELECT count(*)::int AS total FROM saas_pricebooks ${where}`,
      values,
    );
    total = countResult.rows[0]?.total ?? 0;
  }

  const limitPos = values.length + 1;
  const offsetPos = values.length + 2;
  const listParams = [
    ...values,
    ...(limit !== undefined ? [limit] : []),
    ...(offset !== undefined ? [offset] : []),
  ];
  const limitClause = limit !== undefined ? `LIMIT $${limitPos}` : '';
  const offsetClause = offset !== undefined ? `OFFSET $${offsetPos}` : '';
  const result = await db.query<PricebookRow>(
    `SELECT ${PRICEBOOK_SELECT} FROM saas_pricebooks ${where}
      ORDER BY created_at DESC, id DESC
      ${limitClause} ${offsetClause}`,
    listParams,
  );
  return { records: result.rows.map(mapPricebook), total };
}

/** Serializes concurrent version creation for the pricebook. */
async function lockPricebook(id: string, client: Q): Promise<void> {
  await client.query(`SELECT id FROM saas_pricebooks WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
}

async function nextVersionNumber(
  pricebookId: string,
  client: Q,
): Promise<number> {
  const result = await client.query<{ next: number }>(
    `SELECT coalesce(max(version_number), 0) + 1 AS next
       FROM saas_pricebook_versions WHERE pricebook_id = $1`,
    [pricebookId],
  );
  return result.rows[0]?.next ?? 1;
}

async function createVersion(
  input: {
    pricebookId: string;
    versionNumber: number;
    effectiveFrom: Date;
  },
  client: Q,
): Promise<SaasPricebookVersionRecord> {
  const result = await client.query<VersionRow>(
    `INSERT INTO saas_pricebook_versions
       (id, pricebook_id, version_number, status, effective_from)
     VALUES ($1, $2, $3, 'DRAFT', $4)
     RETURNING ${VERSION_SELECT}`,
    [
      randomUUID(),
      input.pricebookId,
      input.versionNumber,
      input.effectiveFrom,
    ],
  );
  return mapVersion(result.rows[0]);
}

async function insertPriceItems(
  versionId: string,
  items: readonly NormalizedPriceItem[],
  client: Q,
): Promise<SaasPriceItemRecord[]> {
  const records: SaasPriceItemRecord[] = [];
  for (const item of items) {
    const result = await client.query<ItemRow>(
      `INSERT INTO saas_price_items
         (id, pricebook_version_id, product_id, package_id, currency_code,
          billing_cycle, base_price, included_building_count,
          additional_building_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${ITEM_SELECT}`,
      [
        randomUUID(),
        versionId,
        item.productId,
        item.packageId,
        item.currencyCode,
        item.billingCycle,
        item.basePrice,
        item.includedBuildingCount,
        item.additionalBuildingPrice,
      ],
    );
    records.push(mapItem(result.rows[0]));
  }
  return records;
}

async function findVersionById(
  id: string,
  q?: Q,
): Promise<SaasPricebookVersionRecord | null> {
  const result = await executor(q).query<VersionRow>(
    `SELECT ${VERSION_SELECT} FROM saas_pricebook_versions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapVersion(row) : null;
}

async function findPublishedVersionByPricebookId(
  pricebookId: string,
  q?: Q,
): Promise<SaasPricebookVersionRecord | null> {
  const result = await executor(q).query<VersionRow>(
    `SELECT ${VERSION_SELECT} FROM saas_pricebook_versions
      WHERE pricebook_id = $1 AND status = 'PUBLISHED'`,
    [pricebookId],
  );
  const row = result.rows[0];
  return row ? mapVersion(row) : null;
}

async function findVersionsByPricebookId(
  pricebookId: string,
  q?: Q,
): Promise<SaasPricebookVersionRecord[]> {
  const result = await executor(q).query<VersionRow>(
    `SELECT ${VERSION_SELECT} FROM saas_pricebook_versions
      WHERE pricebook_id = $1
      ORDER BY version_number DESC`,
    [pricebookId],
  );
  return result.rows.map(mapVersion);
}

async function findItemsByVersionId(
  versionId: string,
  q?: Q,
): Promise<SaasPriceItemRecord[]> {
  const result = await executor(q).query<ItemRow>(
    `SELECT ${ITEM_SELECT} FROM saas_price_items
      WHERE pricebook_version_id = $1
      ORDER BY product_id, package_id, billing_cycle`,
    [versionId],
  );
  return result.rows.map(mapItem);
}

/**
 * Publishes a DRAFT version within the caller's transaction:
 *   1. supersedes the current PUBLISHED version (status + effective_to);
 *   2. marks the version PUBLISHED with publish metadata.
 * The immutability trigger allows exactly this shape for PUBLISHED rows.
 */
async function publishVersion(
  versionId: string,
  publishedByUserId: string,
  supersededVersionId: string | null,
  supersedeEffectiveTo: Date | null,
  client: Q,
): Promise<SaasPricebookVersionRecord> {
  if (supersededVersionId !== null && supersedeEffectiveTo !== null) {
    await client.query(
      `UPDATE saas_pricebook_versions
         SET status = 'SUPERSEDED', effective_to = $2, updated_at = NOW()
       WHERE id = $1`,
      [supersededVersionId, supersedeEffectiveTo],
    );
  }
  const result = await client.query<VersionRow>(
    `UPDATE saas_pricebook_versions
       SET status = 'PUBLISHED',
           published_at = NOW(),
           published_by_user_id = $2,
           updated_at = NOW()
     WHERE id = $1
     RETURNING ${VERSION_SELECT}`,
    [versionId, publishedByUserId],
  );
  return mapVersion(result.rows[0]);
}

export const platformPricebookRepository = {
  createPricebook,
  findPricebookById,
  findPricebookByCode,
  listPricebooks,
  lockPricebook,
  nextVersionNumber,
  createVersion,
  insertPriceItems,
  findVersionById,
  findPublishedVersionByPricebookId,
  findVersionsByPricebookId,
  findItemsByVersionId,
  publishVersion,
};
