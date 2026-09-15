import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUtilityMeterHierarchy,
  UpdateUtilityMeterHierarchyInput,
  UtilityMeterHierarchyFilters,
  UtilityMeterHierarchyRecord,
} from './utility-meter-hierarchy.types';

/**
 * BE-18C — Main / Sub Meter hierarchy persistence.
 *
 * All queries are scoped at the database level (`client_id`, `main_meter_id`,
 * or `sub_meter_id` in the WHERE clause) rather than filtered in memory after
 * a global fetch, per docs/data-isolation.md.
 */

const HIERARCHY_SELECT = `
  id,
  client_id AS "clientId",
  main_meter_id AS "mainMeterId",
  sub_meter_id AS "subMeterId",
  effective_from AS "effectiveFrom",
  effective_until AS "effectiveUntil",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: NewUtilityMeterHierarchy,
): Promise<UtilityMeterHierarchyRecord> {
  const result = await getPool().query<UtilityMeterHierarchyRecord>(
    `INSERT INTO utility_meter_hierarchies
       (id, client_id, main_meter_id, sub_meter_id,
        effective_from, effective_until, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${HIERARCHY_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.mainMeterId,
      input.subMeterId,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<UtilityMeterHierarchyRecord | null> {
  const result = await getPool().query<UtilityMeterHierarchyRecord>(
    `SELECT ${HIERARCHY_SELECT} FROM utility_meter_hierarchies WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** The live Main Meter relationship of a Sub Meter, if any. */
async function findActiveBySubMeter(
  subMeterId: string,
): Promise<UtilityMeterHierarchyRecord | null> {
  const result = await getPool().query<UtilityMeterHierarchyRecord>(
    `SELECT ${HIERARCHY_SELECT} FROM utility_meter_hierarchies
     WHERE sub_meter_id = $1 AND status = 'ACTIVE'`,
    [subMeterId],
  );
  return result.rows[0] ?? null;
}

/** Any relationship between this exact pair, ACTIVE or not. */
async function findByPair(
  mainMeterId: string,
  subMeterId: string,
): Promise<UtilityMeterHierarchyRecord | null> {
  const result = await getPool().query<UtilityMeterHierarchyRecord>(
    `SELECT ${HIERARCHY_SELECT} FROM utility_meter_hierarchies
     WHERE main_meter_id = $1 AND sub_meter_id = $2
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC
     LIMIT 1`,
    [mainMeterId, subMeterId],
  );
  return result.rows[0] ?? null;
}

/** Sub Meters bound to a Main Meter. History is included unless filtered. */
async function listByMainMeter(
  mainMeterId: string,
  filters: UtilityMeterHierarchyFilters = {},
): Promise<UtilityMeterHierarchyRecord[]> {
  const conditions = ['main_meter_id = $1'];
  const values: unknown[] = [mainMeterId];

  if (filters.status) {
    conditions.push('status = $2');
    values.push(filters.status);
  }

  const result = await getPool().query<UtilityMeterHierarchyRecord>(
    `SELECT ${HIERARCHY_SELECT} FROM utility_meter_hierarchies
     WHERE ${conditions.join(' AND ')}
     ORDER BY (status = 'ACTIVE') DESC, created_at ASC`,
    values,
  );
  return result.rows;
}

/** Every relationship ever recorded for a Sub Meter — the history view. */
async function listBySubMeter(
  subMeterId: string,
  filters: UtilityMeterHierarchyFilters = {},
): Promise<UtilityMeterHierarchyRecord[]> {
  const conditions = ['sub_meter_id = $1'];
  const values: unknown[] = [subMeterId];

  if (filters.status) {
    conditions.push('status = $2');
    values.push(filters.status);
  }

  const result = await getPool().query<UtilityMeterHierarchyRecord>(
    `SELECT ${HIERARCHY_SELECT} FROM utility_meter_hierarchies
     WHERE ${conditions.join(' AND ')}
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC`,
    values,
  );
  return result.rows;
}

/**
 * The ACTIVE ancestor chain of a Meter, nearest Main Meter first.
 *
 * Used for cycle detection: if the proposed Sub Meter appears among the
 * proposed Main Meter's ancestors, the binding would close a loop. A
 * recursive CTE resolves the whole chain in one round trip, and `depth` caps
 * the walk so corrupted data can never spin forever.
 */
async function listActiveAncestorIds(
  meterId: string,
  maxDepth = 64,
): Promise<string[]> {
  const result = await getPool().query<{ mainMeterId: string }>(
    `WITH RECURSIVE ancestors AS (
       SELECT h.main_meter_id, 1 AS depth
         FROM utility_meter_hierarchies h
        WHERE h.sub_meter_id = $1 AND h.status = 'ACTIVE'
       UNION ALL
       SELECT h.main_meter_id, a.depth + 1
         FROM utility_meter_hierarchies h
         JOIN ancestors a ON h.sub_meter_id = a.main_meter_id
        WHERE h.status = 'ACTIVE' AND a.depth < $2
     )
     SELECT DISTINCT main_meter_id AS "mainMeterId" FROM ancestors`,
    [meterId, maxDepth],
  );
  return result.rows.map((row) => row.mainMeterId);
}

async function update(
  id: string,
  input: UpdateUtilityMeterHierarchyInput,
): Promise<UtilityMeterHierarchyRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (input.effectiveFrom !== undefined) {
    sets.push(`effective_from = $${index++}`);
    values.push(input.effectiveFrom);
  }
  if (input.effectiveUntil !== undefined) {
    sets.push(`effective_until = $${index++}`);
    values.push(input.effectiveUntil);
  }
  if (input.status !== undefined) {
    sets.push(`status = $${index++}`);
    values.push(input.status);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  sets.push('updated_at = NOW()');
  values.push(id);

  const result = await getPool().query<UtilityMeterHierarchyRecord>(
    `UPDATE utility_meter_hierarchies SET ${sets.join(', ')}
     WHERE id = $${index}
     RETURNING ${HIERARCHY_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

export const utilityMeterHierarchyRepository = {
  create,
  findActiveBySubMeter,
  findById,
  findByPair,
  listActiveAncestorIds,
  listByMainMeter,
  listBySubMeter,
  update,
};
