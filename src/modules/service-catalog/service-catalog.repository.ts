import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  NewServiceCatalogEntry,
  ServiceCatalogFilters,
  ServiceCatalogRecord,
  ServiceCatalogStatus,
  UpdateServiceCatalogEntryInput,
} from './service-catalog.types';

type ServiceCatalogRow = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  status: ServiceCatalogStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const ENTRY_SELECT = `
  id,
  client_id AS "clientId",
  code,
  name,
  description,
  category,
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: ServiceCatalogRow): ServiceCatalogRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function insertEntry(
  executor: Pick<PoolClient, 'query'> = getPool(),
  entry: NewServiceCatalogEntry,
): Promise<ServiceCatalogRecord> {
  const result = await executor.query<ServiceCatalogRow>(
    `INSERT INTO service_catalog
       (id, client_id, code, name, description, category, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)
     RETURNING ${ENTRY_SELECT}`,
    [
      randomUUID(),
      entry.clientId,
      entry.code,
      entry.name,
      entry.description,
      entry.category,
      entry.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<ServiceCatalogRecord | null> {
  const result = await executor.query<ServiceCatalogRow>(
    `SELECT ${ENTRY_SELECT} FROM service_catalog WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByCodeForClient(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  code: string,
): Promise<ServiceCatalogRecord | null> {
  const result = await executor.query<ServiceCatalogRow>(
    `SELECT ${ENTRY_SELECT} FROM service_catalog
       WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  accessibleClientIds: string[],
  filters: ServiceCatalogFilters,
): Promise<ServiceCatalogRecord[]> {
  if (accessibleClientIds.length === 0) {
    return [];
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  // Caller is bound to accessible Client set (no-leak posture).
  conditions.push(
    `client_id = ANY($${idx++})`,
  );
  values.push(accessibleClientIds);

  // Optional explicit clientId filter (already proven in-scope by the caller;
  // applied here for determinism).
  if (filters.clientId) {
    conditions.push(`client_id = $${idx++}`);
    values.push(filters.clientId);
  }
  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters.category) {
    conditions.push(`category = $${idx++}`);
    values.push(filters.category);
  }
  if (filters.search) {
    const search = `%${filters.search.trim()}%`;
    conditions.push(
      `(code ILIKE $${idx} OR name ILIKE $${idx} OR COALESCE(category,'') ILIKE $${idx})`,
    );
    values.push(search);
    idx++;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const result = await executor.query<ServiceCatalogRow>(
    `SELECT ${ENTRY_SELECT} FROM service_catalog ${where} ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function updateEntry(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
  input: UpdateServiceCatalogEntryInput,
): Promise<ServiceCatalogRecord | null> {
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
  if (input.category !== undefined) {
    sets.push(`category = $${idx++}`);
    values.push(input.category);
  }

  if (sets.length === 0) {
    return findById(executor, id);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const result = await executor.query<ServiceCatalogRow>(
    `UPDATE service_catalog SET ${sets.join(', ')}
       WHERE id = $${idx} RETURNING ${ENTRY_SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function deactivate(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<ServiceCatalogRecord | null> {
  const result = await executor.query<ServiceCatalogRow>(
    `UPDATE service_catalog
       SET status = 'INACTIVE', updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${ENTRY_SELECT}`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const serviceCatalogRepository = {
  insertEntry,
  findById,
  findByCodeForClient,
  listScoped,
  updateEntry,
  deactivate,
};
