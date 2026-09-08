import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateVisitorInput,
  UpdateVisitorInput,
  VisitorIdentityType,
  VisitorListFilters,
  VisitorRecord,
  VisitorStatus,
} from './visitor.types';

/**
 * BE-13A — Visitor Identity repository.
 *
 * Holds the single shared visitor identity master row for the BE-13
 * Front Desk domain. All queries are Client-scoped by the service
 * layer; the repository never applies access rules itself.
 */

type VisitorRow = {
  id: string;
  client_id: string;
  full_name: string;
  identity_type: VisitorIdentityType;
  identity_number: string | null;
  phone: string | null;
  email: string | null;
  organization_name: string | null;
  notes: string | null;
  status: VisitorStatus;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const VISITOR_COLUMNS = `
  id, client_id, full_name, identity_type, identity_number,
  phone, email, organization_name, notes, status,
  created_by_user_id, created_at, updated_at
`;

function mapRow(row: VisitorRow): VisitorRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    fullName: row.full_name,
    identityType: row.identity_type,
    identityNumber: row.identity_number,
    phone: row.phone,
    email: row.email,
    organizationName: row.organization_name,
    notes: row.notes,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: CreateVisitorInput): Promise<VisitorRecord> {
  const result = await getPool().query<VisitorRow>(
    `INSERT INTO visitors
       (id, client_id, full_name, identity_type, identity_number,
        phone, email, organization_name, notes, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${VISITOR_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.fullName,
      input.identityType ?? 'NONE',
      input.identityNumber ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.organizationName ?? null,
      input.notes ?? null,
      input.status ?? 'ACTIVE',
      input.createdByUserId ?? null,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(id: string): Promise<VisitorRecord | null> {
  const result = await getPool().query<VisitorRow>(
    `SELECT ${VISITOR_COLUMNS} FROM visitors WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Duplicate-avoidance lookup: finds the visitor holding the same
 * identity document within the Client, regardless of status.
 */
export async function findByClientAndIdentity(
  clientId: string,
  identityType: VisitorIdentityType,
  identityNumber: string,
): Promise<VisitorRecord | null> {
  const result = await getPool().query<VisitorRow>(
    `SELECT ${VISITOR_COLUMNS}
     FROM visitors
     WHERE client_id = $1
       AND identity_type = $2
       AND identity_number = $3`,
    [clientId, identityType, identityNumber],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByClient(
  clientId: string,
  filter: VisitorListFilters = {},
): Promise<VisitorRecord[]> {
  const conditions = ['client_id = $1'];
  const values: unknown[] = [clientId];

  if (filter.search) {
    values.push(`%${escapeLike(filter.search)}%`);
    conditions.push(`full_name ILIKE $${values.length} ESCAPE '\\'`);
  }
  if (filter.identityType) {
    values.push(filter.identityType);
    conditions.push(`identity_type = $${values.length}`);
  }
  if (filter.identityNumber) {
    values.push(filter.identityNumber);
    conditions.push(`identity_number = $${values.length}`);
  }
  if (filter.phone) {
    values.push(filter.phone);
    conditions.push(`phone = $${values.length}`);
  }
  if (filter.email) {
    values.push(filter.email.toLowerCase());
    conditions.push(`LOWER(email) = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<VisitorRow>(
    `SELECT ${VISITOR_COLUMNS}
     FROM visitors
     WHERE ${conditions.join(' AND ')}
     ORDER BY full_name ASC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateVisitorInput,
): Promise<VisitorRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.fullName !== undefined) {
    values.push(input.fullName);
    sets.push(`full_name = $${values.length}`);
  }
  if (input.identityType !== undefined) {
    values.push(input.identityType);
    sets.push(`identity_type = $${values.length}`);
  }
  if (input.identityNumber !== undefined) {
    values.push(input.identityNumber);
    sets.push(`identity_number = $${values.length}`);
  }
  if (input.phone !== undefined) {
    values.push(input.phone);
    sets.push(`phone = $${values.length}`);
  }
  if (input.email !== undefined) {
    values.push(input.email);
    sets.push(`email = $${values.length}`);
  }
  if (input.organizationName !== undefined) {
    values.push(input.organizationName);
    sets.push(`organization_name = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<VisitorRow>(
    `UPDATE visitors
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${VISITOR_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export const visitorRepository = {
  create,
  findByClientAndIdentity,
  findById,
  listByClient,
  update,
};
