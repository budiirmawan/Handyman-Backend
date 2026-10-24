import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { ServiceCatalogStatus } from '../service-catalog/service-catalog.types';
import {
  type NewServiceCategory,
  type NewServiceCatalogAvailability,
  type PublicServiceCatalogAvailability,
  type PublicServiceCategory,
  type ServiceCatalogAvailabilityRecord,
  type ServiceCatalogItemView,
  type ServiceCatalogReadModel,
  type ServiceCategoryFilters,
  type ServiceCategoryRecord,
  type ServiceCategoryStatus,
  type ServiceCatalogSource,
  type StarterPackCategory,
  type StarterPackImportResult,
  type StarterPackService,
  type UpdateServiceCategoryInput,
} from './service-catalog-master.types';

type Executor = Pick<PoolClient, 'query'>;

type CategoryRow = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ServiceCategoryStatus;
  source: ServiceCatalogSource;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

type AvailabilityRow = {
  id: string;
  clientId: string;
  serviceCatalogId: string;
  buildingId: string;
  status: ServiceCategoryStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

type ServiceItemRow = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: ServiceCatalogStatus;
  source: ServiceCatalogSource;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string | null;
};

const CATEGORY_SELECT = `
  id,
  client_id AS "clientId",
  code,
  name,
  description,
  status,
  source,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const AVAILABILITY_SELECT = `
  id,
  client_id AS "clientId",
  service_catalog_id AS "serviceCatalogId",
  building_id AS "buildingId",
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapCategory(row: CategoryRow): ServiceCategoryRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    source: row.source,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAvailability(
  row: AvailabilityRow,
): ServiceCatalogAvailabilityRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    serviceCatalogId: row.serviceCatalogId,
    buildingId: row.buildingId,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPublicCategory(record: ServiceCategoryRecord): PublicServiceCategory {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
    source: record.source,
    createdByUserId: record.createdByUserId,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

function toPublicAvailability(
  record: ServiceCatalogAvailabilityRecord,
): PublicServiceCatalogAvailability {
  return {
    id: record.id,
    clientId: record.clientId,
    serviceCatalogId: record.serviceCatalogId,
    buildingId: record.buildingId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// ---------------------------------------------------------------------------
// Service Category master
// ---------------------------------------------------------------------------

async function insertCategory(
  ex: Executor = getPool(),
  entry: NewServiceCategory,
): Promise<ServiceCategoryRecord> {
  const result = await ex.query<CategoryRow>(
    `INSERT INTO service_category
       (id, client_id, code, name, description, status, source, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7)
     RETURNING ${CATEGORY_SELECT}`,
    [
      randomUUID(),
      entry.clientId,
      entry.code,
      entry.name,
      entry.description,
      entry.source,
      entry.createdByUserId,
    ],
  );
  return mapCategory(result.rows[0]);
}

async function findCategoryById(
  ex: Executor = getPool(),
  id: string,
): Promise<ServiceCategoryRecord | null> {
  const result = await ex.query<CategoryRow>(
    `SELECT ${CATEGORY_SELECT} FROM service_category WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapCategory(row) : null;
}

async function findCategoryByCodeForClient(
  ex: Executor = getPool(),
  clientId: string,
  code: string,
): Promise<ServiceCategoryRecord | null> {
  const result = await ex.query<CategoryRow>(
    `SELECT ${CATEGORY_SELECT} FROM service_category
       WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  const row = result.rows[0];
  return row ? mapCategory(row) : null;
}

async function listCategories(
  ex: Executor = getPool(),
  accessibleClientIds: string[],
  filters: ServiceCategoryFilters,
): Promise<ServiceCategoryRecord[]> {
  if (accessibleClientIds.length === 0) return [];
  const conditions = ['client_id = ANY($1::uuid[])'];
  const values: unknown[] = [accessibleClientIds];
  if (filters.clientId) {
    values.push(filters.clientId);
    conditions.push(`client_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  const result = await ex.query<CategoryRow>(
    `SELECT ${CATEGORY_SELECT} FROM service_category
      WHERE ${conditions.join(' AND ')}
      ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapCategory);
}

async function updateCategory(
  ex: Executor = getPool(),
  id: string,
  input: UpdateServiceCategoryInput,
): Promise<ServiceCategoryRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push(`description = $${idx++}`);
    values.push(input.description);
  }
  if (sets.length === 0) return findCategoryById(ex, id);
  sets.push('updated_at = NOW()');
  values.push(id);
  const result = await ex.query<CategoryRow>(
    `UPDATE service_category SET ${sets.join(', ')}
       WHERE id = $${idx} RETURNING ${CATEGORY_SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapCategory(row) : null;
}

async function deactivateCategory(
  ex: Executor = getPool(),
  id: string,
): Promise<ServiceCategoryRecord | null> {
  const result = await ex.query<CategoryRow>(
    `UPDATE service_category
       SET status = 'INACTIVE', updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${CATEGORY_SELECT}`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapCategory(row) : null;
}

async function countActiveServicesForCategory(
  ex: Executor = getPool(),
  categoryId: string,
): Promise<number> {
  const result = await ex.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM service_catalog
      WHERE service_category_id = $1 AND status = 'ACTIVE'`,
    [categoryId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * Links an EXISTING service item to a governed category. The category text is
 * derived authoritatively from the master (never caller-supplied) so the item
 * display name and the master never diverge.
 */
async function linkServiceCategory(
  ex: Executor = getPool(),
  serviceCatalogId: string,
  categoryId: string,
  categoryCode: string,
  categoryName: string,
): Promise<
  | { id: string; clientId: string; code: string; categoryCode: string }
  | null
> {
  const result = await ex.query<{
    id: string;
    clientId: string;
    code: string;
  }>(
    `UPDATE service_catalog
       SET service_category_id = $2, category = $3, updated_at = NOW()
     WHERE id = $1
     RETURNING id, client_id AS "clientId", code`,
    [serviceCatalogId, categoryId, categoryName],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, clientId: row.clientId, code: row.code, categoryCode }
    : null;
}

/** Derives the Client that owns a Building (Building → Property → Client). */
async function loadBuildingClientId(
  ex: Executor = getPool(),
  buildingId: string,
): Promise<string | null> {
  const result = await ex.query<{ clientId: string }>(
    `SELECT p.client_id AS "clientId"
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [buildingId],
  );
  return result.rows[0]?.clientId ?? null;
}

// ---------------------------------------------------------------------------
// Service Catalog availability
// ---------------------------------------------------------------------------

async function insertAvailability(
  ex: Executor = getPool(),
  entry: NewServiceCatalogAvailability,
): Promise<ServiceCatalogAvailabilityRecord> {
  const result = await ex.query<AvailabilityRow>(
    `INSERT INTO service_catalog_availability
       (id, client_id, service_catalog_id, building_id, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5)
     RETURNING ${AVAILABILITY_SELECT}`,
    [
      randomUUID(),
      entry.clientId,
      entry.serviceCatalogId,
      entry.buildingId,
      entry.createdByUserId,
    ],
  );
  return mapAvailability(result.rows[0]);
}

async function findAvailabilityById(
  ex: Executor = getPool(),
  id: string,
): Promise<ServiceCatalogAvailabilityRecord | null> {
  const result = await ex.query<AvailabilityRow>(
    `SELECT ${AVAILABILITY_SELECT} FROM service_catalog_availability
       WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapAvailability(row) : null;
}

async function findAvailabilityForServiceAndBuilding(
  ex: Executor = getPool(),
  serviceCatalogId: string,
  buildingId: string,
): Promise<ServiceCatalogAvailabilityRecord | null> {
  const result = await ex.query<AvailabilityRow>(
    `SELECT ${AVAILABILITY_SELECT} FROM service_catalog_availability
       WHERE service_catalog_id = $1 AND building_id = $2`,
    [serviceCatalogId, buildingId],
  );
  const row = result.rows[0];
  return row ? mapAvailability(row) : null;
}

async function listAvailabilityForService(
  ex: Executor = getPool(),
  serviceCatalogId: string,
): Promise<ServiceCatalogAvailabilityRecord[]> {
  const result = await ex.query<AvailabilityRow>(
    `SELECT ${AVAILABILITY_SELECT} FROM service_catalog_availability
       WHERE service_catalog_id = $1
      ORDER BY building_id ASC`,
    [serviceCatalogId],
  );
  return result.rows.map(mapAvailability);
}

async function deactivateAvailability(
  ex: Executor = getPool(),
  id: string,
): Promise<ServiceCatalogAvailabilityRecord | null> {
  const result = await ex.query<AvailabilityRow>(
    `UPDATE service_catalog_availability
       SET status = 'INACTIVE', updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${AVAILABILITY_SELECT}`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapAvailability(row) : null;
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

async function findServiceItemById(
  ex: Executor = getPool(),
  id: string,
): Promise<ServiceItemRow | null> {
  const result = await ex.query<ServiceItemRow>(
    `SELECT s.id,
            s.client_id AS "clientId",
            s.code,
            s.name,
            s.description,
            s.status,
            s.source,
            s.service_category_id AS "categoryId",
            c.code AS "categoryCode",
            c.name AS "categoryName"
       FROM service_catalog s
       LEFT JOIN service_category c ON c.id = s.service_category_id
      WHERE s.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ?? null;
}

async function listActiveServiceItems(
  ex: Executor = getPool(),
  clientId: string,
): Promise<ServiceItemRow[]> {
  const result = await ex.query<ServiceItemRow>(
    `SELECT s.id,
            s.client_id AS "clientId",
            s.code,
            s.name,
            s.description,
            s.status,
            s.source,
            s.service_category_id AS "categoryId",
            c.code AS "categoryCode",
            c.name AS "categoryName"
       FROM service_catalog s
       LEFT JOIN service_category c ON c.id = s.service_category_id
      WHERE s.client_id = $1 AND s.status = 'ACTIVE'
      ORDER BY COALESCE(c.code, '~'), s.code ASC`,
    [clientId],
  );
  return result.rows;
}

async function listServicesWithAvailability(
  ex: Executor = getPool(),
  clientId: string,
  serviceIds: string[],
): Promise<Set<string>> {
  const scoped = new Set<string>();
  if (serviceIds.length === 0) return scoped;
  const result = await ex.query<{ service_catalog_id: string }>(
    `SELECT DISTINCT service_catalog_id
       FROM service_catalog_availability
      WHERE client_id = $1 AND service_catalog_id = ANY($2::uuid[])`,
    [clientId, serviceIds],
  );
  for (const row of result.rows) scoped.add(row.service_catalog_id);
  return scoped;
}

async function listActiveBuildingGrants(
  ex: Executor = getPool(),
  clientId: string,
  serviceIds: string[],
  buildingId: string,
): Promise<Set<string>> {
  const grants = new Set<string>();
  if (serviceIds.length === 0) return grants;
  const result = await ex.query<{ service_catalog_id: string }>(
    `SELECT service_catalog_id
       FROM service_catalog_availability
      WHERE client_id = $1
        AND service_catalog_id = ANY($2::uuid[])
        AND building_id = $3
        AND status = 'ACTIVE'`,
    [clientId, serviceIds, buildingId],
  );
  for (const row of result.rows) grants.add(row.service_catalog_id);
  return grants;
}

// ---------------------------------------------------------------------------
// Starter pack import (idempotent)
// ---------------------------------------------------------------------------

/**
 * Insert-or-resolve a starter category, returning its id and whether this call
 * inserted it. `ON CONFLICT DO NOTHING` + a follow-up SELECT is idempotent and
 * concurrency-safe: a racing import that committed first is observed by the
 * SELECT after the unique-index wait resolves.
 */
async function resolveStarterCategory(
  ex: Executor = getPool(),
  clientId: string,
  category: StarterPackCategory,
  actorUserId: string,
): Promise<{ id: string; inserted: boolean }> {
  const inserted = await ex.query<{ id: string }>(
    `INSERT INTO service_category
       (id, client_id, code, name, description, status, source, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 'STARTER_PACK', $6)
     ON CONFLICT (client_id, code) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      clientId,
      category.code,
      category.name,
      category.description,
      actorUserId,
    ],
  );
  if (inserted.rows[0]) {
    return { id: inserted.rows[0].id, inserted: true };
  }
  const existing = await ex.query<{ id: string }>(
    `SELECT id FROM service_category WHERE client_id = $1 AND code = $2`,
    [clientId, category.code],
  );
  return { id: existing.rows[0]?.id as string, inserted: false };
}

async function resolveStarterService(
  ex: Executor = getPool(),
  clientId: string,
  service: StarterPackService,
  categoryId: string,
  actorUserId: string,
): Promise<{ id: string; inserted: boolean }> {
  const inserted = await ex.query<{ id: string }>(
    `INSERT INTO service_catalog
       (id, client_id, code, name, description, category, status, source,
        service_category_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'STARTER_PACK', $7, $8)
     ON CONFLICT (client_id, code) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      clientId,
      service.code,
      service.name,
      service.description,
      service.categoryCode,
      categoryId,
      actorUserId,
    ],
  );
  if (inserted.rows[0]) {
    return { id: inserted.rows[0].id, inserted: true };
  }
  const existing = await ex.query<{ id: string }>(
    `SELECT id FROM service_catalog WHERE client_id = $1 AND code = $2`,
    [clientId, service.code],
  );
  return { id: existing.rows[0]?.id as string, inserted: false };
}

/**
 * Runs the starter-pack import inside the caller-provided transaction. Returns
 * a summary; never throws on already-present rows (idempotent).
 */
export async function runStarterPackImport(
  clientId: string,
  actorUserId: string,
  categories: readonly StarterPackCategory[],
  services: readonly StarterPackService[],
  ex: Executor = getPool(),
): Promise<
  Omit<StarterPackImportResult, 'clientId' | 'operationKey' | 'replayed'>
> {
  const categoryIds = new Map<string, string>();
  let categoriesCreated = 0;
  let categoriesSkipped = 0;

  for (const category of categories) {
    const resolved = await resolveStarterCategory(
      ex,
      clientId,
      category,
      actorUserId,
    );
    categoryIds.set(category.code, resolved.id);
    if (resolved.inserted) categoriesCreated += 1;
    else categoriesSkipped += 1;
  }

  let servicesCreated = 0;
  let servicesSkipped = 0;
  for (const service of services) {
    const categoryId = categoryIds.get(service.categoryCode);
    if (!categoryId) {
      throw new Error(
        `Starter pack integrity violation: unknown category ${service.categoryCode}`,
      );
    }
    const resolved = await resolveStarterService(
      ex,
      clientId,
      service,
      categoryId,
      actorUserId,
    );
    if (resolved.inserted) servicesCreated += 1;
    else servicesSkipped += 1;
  }

  return {
    categoriesCreated,
    categoriesSkipped,
    servicesCreated,
    servicesSkipped,
    totalCategories: categories.length,
    totalServices: services.length,
  };
}

export const serviceCatalogMasterRepository = {
  // categories
  insertCategory,
  findCategoryById,
  findCategoryByCodeForClient,
  listCategories,
  updateCategory,
  deactivateCategory,
  countActiveServicesForCategory,
  linkServiceCategory,
  loadBuildingClientId,
  toPublicCategory,
  // availability
  insertAvailability,
  findAvailabilityById,
  findAvailabilityForServiceAndBuilding,
  listAvailabilityForService,
  deactivateAvailability,
  toPublicAvailability,
  // read model
  findServiceItemById,
  listActiveServiceItems,
  listServicesWithAvailability,
  listActiveBuildingGrants,
  // starter pack
  runStarterPackImport,
};

export type { ServiceCatalogReadModel, ServiceCatalogItemView };
