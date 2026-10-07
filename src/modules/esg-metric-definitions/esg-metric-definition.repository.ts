import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  EsgMetricCategory,
  EsgCalculationMethod,
  EsgMetricDefinitionFilters,
  EsgMetricDefinitionRecord,
  EsgMetricStatus,
  NewEsgMetricDefinition,
  UpdateEsgMetricDefinitionInput,
} from './esg-metric-definition.types';

type Row = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  category: EsgMetricCategory;
  uomId: string | null;
  calculationMethod: EsgCalculationMethod;
  status: EsgMetricStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  code,
  name,
  description,
  category AS "category",
  uom_id AS "uomId",
  calculation_method AS "calculationMethod",
  status,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function map(row: Row): EsgMetricDefinitionRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    uomId: row.uomId,
    calculationMethod: row.calculationMethod,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function insert(
  executor: Pick<PoolClient, 'query'> = getPool(),
  entry: NewEsgMetricDefinition,
): Promise<EsgMetricDefinitionRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO esg_metric_definitions
       (id, client_id, code, name, description, category, uom_id, calculation_method, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      entry.clientId,
      entry.code,
      entry.name,
      entry.description,
      entry.category,
      entry.uomId,
      entry.calculationMethod,
      entry.createdByUserId,
    ],
  );
  return map(result.rows[0]);
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<EsgMetricDefinitionRecord | null> {
  const result = await executor.query<Row>(
    `SELECT ${SELECT} FROM esg_metric_definitions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

async function findByCodeForClient(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  code: string,
): Promise<EsgMetricDefinitionRecord | null> {
  const result = await executor.query<Row>(
    `SELECT ${SELECT} FROM esg_metric_definitions
       WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

async function listScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  accessibleClientIds: string[],
  filters: EsgMetricDefinitionFilters,
): Promise<EsgMetricDefinitionRecord[]> {
  if (accessibleClientIds.length === 0) {
    return [];
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  conditions.push(`client_id = ANY($${idx++})`);
  values.push(accessibleClientIds);

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
  if (filters.calculationMethod) {
    conditions.push(`calculation_method = $${idx++}`);
    values.push(filters.calculationMethod);
  }
  if (filters.uomId) {
    conditions.push(`uom_id = $${idx++}`);
    values.push(filters.uomId);
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
  const result = await executor.query<Row>(
    `SELECT ${SELECT} FROM esg_metric_definitions ${where} ORDER BY code ASC`,
    values,
  );
  return result.rows.map(map);
}

async function update(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
  input: UpdateEsgMetricDefinitionInput & {
    name?: string;
    description?: string | null;
    category?: EsgMetricCategory;
    uomId?: string | null;
    calculationMethod?: EsgCalculationMethod;
  },
): Promise<EsgMetricDefinitionRecord | null> {
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
  if (input.calculationMethod !== undefined) {
    sets.push(`calculation_method = $${idx++}`);
    values.push(input.calculationMethod);
  }
  if (input.uomId !== undefined) {
    sets.push(`uom_id = $${idx++}`);
    values.push(input.uomId);
  }

  if (sets.length === 0) {
    return findById(executor, id);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const result = await executor.query<Row>(
    `UPDATE esg_metric_definitions SET ${sets.join(', ')}
       WHERE id = $${idx} RETURNING ${SELECT}`,
    values,
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

async function deactivate(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<EsgMetricDefinitionRecord | null> {
  const result = await executor.query<Row>(
    `UPDATE esg_metric_definitions
       SET status = 'INACTIVE', updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${SELECT}`,
    [id],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

export const esgMetricDefinitionRepository = {
  insert,
  findById,
  findByCodeForClient,
  listScoped,
  update,
  deactivate,
};
