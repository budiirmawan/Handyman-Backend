import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ClientRecord,
  ClientStatus,
  NewClient,
  UpdateClientInput,
} from './client.types';

/**
 * Registry read filters. `clientIds` is the caller's authorized reach:
 * `null`/omitted means installation-wide (the Owner path), an array limits the
 * result to those Clients, and an EMPTY array matches nothing. It is resolved
 * by `client.scope.ts`, never taken from the request.
 */
export type ClientListQuery = {
  status?: ClientStatus;
  search?: string;
  clientIds?: readonly string[] | null;
  limit?: number;
  offset?: number;
};

type ClientRow = {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  description: string | null;
  status: ClientStatus;
  createdAt: Date;
  updatedAt: Date;
};

const CLIENT_SELECT = `
  id,
  code,
  name,
  legal_name AS "legalName",
  tax_id AS "taxId",
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapClientRow(row: ClientRow): ClientRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    taxId: row.taxId,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createClient(input: NewClient): Promise<ClientRecord> {
  const result = await getPool().query<ClientRow>(
    `INSERT INTO clients (id, code, name, legal_name, tax_id, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${CLIENT_SELECT}`,
    [
      randomUUID(),
      input.code,
      input.name,
      input.legalName,
      input.taxId,
      input.description,
      input.status,
    ],
  );

  return mapClientRow(result.rows[0]);
}

async function findById(id: string): Promise<ClientRecord | null> {
  const result = await getPool().query<ClientRow>(
    `SELECT ${CLIENT_SELECT} FROM clients WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

async function findByCode(code: string): Promise<ClientRecord | null> {
  const result = await getPool().query<ClientRow>(
    `SELECT ${CLIENT_SELECT} FROM clients WHERE code = $1`,
    [code],
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

/**
 * CR-HM-BE-CLIENT-MASTER-01 — shared WHERE clause for registry reads.
 *
 * `$1` status filter, `$2` escaped literal search term, `$3` authorized
 * Client reach (`NULL` = installation-wide, i.e. the Owner).
 *
 * Filtering is never an authorization decision: `clientIds` is resolved by
 * `client.scope.ts` from the canonical RBAC/permission + Building-assignment
 * model before it reaches this query.
 *
 * `status IN ('ACTIVE','INACTIVE')` is a DOMAIN predicate, not a filter: the
 * `clients` table is shared with the SaaS customer registry (migration 0360
 * extended the CHECK with PROSPECT / TRIAL / GRACE / SUSPENDED / TERMINATED).
 * Those are platform-plane lifecycle states, not business Client statuses, and
 * are never exposed through the business Client API.
 */
const CLIENT_FILTER_SQL = `
  status IN ('ACTIVE', 'INACTIVE')
  AND ($1::text IS NULL OR status = $1)
  AND (
    $2::text IS NULL
    OR code ILIKE '%' || $2 || '%'
    OR name ILIKE '%' || $2 || '%'
  )
  AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
`;

function escapeLikePattern(value: string): string {
  // Treat the search term as a literal: `%`, `_` and `\` are escaped so a
  // caller cannot widen the match with LIKE metacharacters.
  return value.replace(/[\\%_]/g, '\\$&');
}

function listFilterParams(query: ClientListQuery): unknown[] {
  return [
    query.status ?? null,
    query.search ? escapeLikePattern(query.search) : null,
    query.clientIds === undefined || query.clientIds === null
      ? null
      : [...query.clientIds],
  ];
}

async function listClients(query: ClientListQuery = {}): Promise<ClientRecord[]> {
  const params = listFilterParams(query);
  let sql = `SELECT ${CLIENT_SELECT} FROM clients WHERE ${CLIENT_FILTER_SQL} ORDER BY code ASC`;

  if (query.limit !== undefined && query.offset !== undefined) {
    params.push(query.limit, query.offset);
    sql += ` LIMIT $4 OFFSET $5`;
  }

  const result = await getPool().query<ClientRow>(sql, params);
  return result.rows.map(mapClientRow);
}

async function countClients(query: ClientListQuery = {}): Promise<number> {
  const result = await getPool().query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM clients WHERE ${CLIENT_FILTER_SQL}`,
    listFilterParams(query),
  );

  return result.rows[0]?.total ?? 0;
}

async function updateClient(
  id: string,
  input: UpdateClientInput,
): Promise<ClientRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.legalName !== undefined) {
    values.push(input.legalName);
    sets.push(`legal_name = $${values.length}`);
  }
  if (input.taxId !== undefined) {
    values.push(input.taxId);
    sets.push(`tax_id = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<ClientRow>(
    `UPDATE clients SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${CLIENT_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapClientRow(row) : null;
}

export const clientRepository = {
  countClients,
  createClient,
  findById,
  findByCode,
  listClients,
  updateClient,
};
