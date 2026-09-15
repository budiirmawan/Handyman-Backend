import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewOrganization,
  OrganizationRecord,
  OrganizationStatus,
  UpdateOrganizationInput,
} from './organization.types';

type OrganizationRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  description: string | null;
  status: OrganizationStatus;
  created_at: Date;
  updated_at: Date;
};

const ORG_SELECT = `
  id,
  client_id,
  code,
  name,
  description,
  status,
  created_at,
  updated_at
`;

function mapRow(row: OrganizationRow): OrganizationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createOrganization(input: NewOrganization): Promise<OrganizationRecord> {
  const result = await getPool().query<OrganizationRow>(
    `INSERT INTO organizations (id, client_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ORG_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<OrganizationRecord | null> {
  const result = await getPool().query<OrganizationRow>(
    `SELECT ${ORG_SELECT} FROM organizations WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByClientIdAndCode(
  clientId: string,
  code: string,
): Promise<OrganizationRecord | null> {
  const result = await getPool().query<OrganizationRow>(
    `SELECT ${ORG_SELECT} FROM organizations WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByClientId(clientId: string): Promise<OrganizationRecord[]> {
  const result = await getPool().query<OrganizationRow>(
    `SELECT ${ORG_SELECT} FROM organizations
     WHERE client_id = $1
     ORDER BY code ASC`,
    [clientId],
  );

  return result.rows.map(mapRow);
}

async function updateOrganization(
  id: string,
  input: UpdateOrganizationInput,
): Promise<OrganizationRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

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

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<OrganizationRow>(
    `UPDATE organizations SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${ORG_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const organizationRepository = {
  createOrganization,
  findById,
  findByClientIdAndCode,
  listByClientId,
  updateOrganization,
};
