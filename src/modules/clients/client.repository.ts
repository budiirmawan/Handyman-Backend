import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ClientRecord,
  ClientStatus,
  NewClient,
  UpdateClientInput,
} from './client.types';

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

async function listClients(): Promise<ClientRecord[]> {
  const result = await getPool().query<ClientRow>(
    `SELECT ${CLIENT_SELECT} FROM clients ORDER BY code ASC`,
  );

  return result.rows.map(mapClientRow);
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
  createClient,
  findById,
  findByCode,
  listClients,
  updateClient,
};
