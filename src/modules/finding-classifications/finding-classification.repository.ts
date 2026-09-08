import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  FindingClassificationRecord,
  FindingClassificationStatus,
  NewFindingClassification,
  UpdateFindingClassificationInput,
} from './finding-classification.types';

type Row = FindingClassificationRecord;
const SELECT = `id, client_id AS "clientId", code, name, description, status,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewFindingClassification): Promise<Row> {
  const result = await getPool().query<Row>(
    `INSERT INTO finding_classifications
       (id, client_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.code, input.name, input.description, input.status],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM finding_classifications WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByCodeForClient(clientId: string, code: string): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM finding_classifications
     WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  return result.rows[0] ?? null;
}

async function listByClient(clientId: string): Promise<Row[]> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM finding_classifications
     WHERE client_id = $1 ORDER BY code`,
    [clientId],
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateFindingClassificationInput,
): Promise<Row | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) { values.push(input.name); sets.push(`name = $${values.length}`); }
  if (input.description !== undefined) { values.push(input.description); sets.push(`description = $${values.length}`); }
  if (input.status !== undefined) { values.push(input.status); sets.push(`status = $${values.length}`); }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<Row>(
    `UPDATE finding_classifications SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function updateStatus(id: string, status: FindingClassificationStatus): Promise<Row | null> {
  return update(id, { status });
}

export const findingClassificationRepository = {
  create,
  findByCodeForClient,
  findById,
  listByClient,
  update,
  updateStatus,
};
