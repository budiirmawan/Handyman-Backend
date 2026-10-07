import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { FindingSeverityRecord, FindingSeverityStatus, NewFindingSeverity, UpdateFindingSeverityInput } from './finding-severity.types';

type Row = FindingSeverityRecord;
const SELECT = `id, client_id AS "clientId", code, name, rank, description, status,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewFindingSeverity): Promise<Row> {
  const result = await getPool().query<Row>(
    `INSERT INTO finding_severities (id, client_id, code, name, rank, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.code, input.name, input.rank, input.description, input.status],
  );
  return result.rows[0];
}
async function findById(id: string): Promise<Row | null> {
  const result = await getPool().query<Row>(`SELECT ${SELECT} FROM finding_severities WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}
async function findByCodeForClient(clientId: string, code: string): Promise<Row | null> {
  const result = await getPool().query<Row>(`SELECT ${SELECT} FROM finding_severities WHERE client_id = $1 AND code = $2`, [clientId, code]);
  return result.rows[0] ?? null;
}
async function listByClient(clientId: string): Promise<Row[]> {
  const result = await getPool().query<Row>(`SELECT ${SELECT} FROM finding_severities WHERE client_id = $1 ORDER BY rank, code`, [clientId]);
  return result.rows;
}
async function update(id: string, input: UpdateFindingSeverityInput): Promise<Row | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) { values.push(input.name); sets.push(`name = $${values.length}`); }
  if (input.rank !== undefined) { values.push(input.rank); sets.push(`rank = $${values.length}`); }
  if (input.description !== undefined) { values.push(input.description); sets.push(`description = $${values.length}`); }
  if (input.status !== undefined) { values.push(input.status); sets.push(`status = $${values.length}`); }
  if (!sets.length) return findById(id);
  values.push(id); sets.push('updated_at = NOW()');
  const result = await getPool().query<Row>(`UPDATE finding_severities SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${SELECT}`, values);
  return result.rows[0] ?? null;
}
async function updateStatus(id: string, status: FindingSeverityStatus): Promise<Row | null> {
  return update(id, { status });
}
export const findingSeverityRepository = { create, findByCodeForClient, findById, listByClient, update, updateStatus };
