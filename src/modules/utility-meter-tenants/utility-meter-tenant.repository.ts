import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUtilityMeterTenantAssignment,
  UpdateUtilityMeterTenantAssignmentInput,
  UtilityMeterTenantAssignmentFilters,
  UtilityMeterTenantAssignmentRecord,
} from './utility-meter-tenant.types';

/**
 * BE-18D — Tenant Meter persistence.
 *
 * All queries are scoped at the database level (`meter_id`,
 * `tenant_company_id`, `space_id`, or `building_id` in the WHERE clause)
 * rather than filtered in memory after a global fetch, per
 * docs/data-isolation.md.
 */

const ASSIGNMENT_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  meter_id AS "meterId",
  tenant_company_id AS "tenantCompanyId",
  space_id AS "spaceId",
  effective_from AS "effectiveFrom",
  effective_until AS "effectiveUntil",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: NewUtilityMeterTenantAssignment,
): Promise<UtilityMeterTenantAssignmentRecord> {
  const result = await getPool().query<UtilityMeterTenantAssignmentRecord>(
    `INSERT INTO utility_meter_tenant_assignments
       (id, client_id, building_id, meter_id, tenant_company_id, space_id,
        effective_from, effective_until, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ASSIGNMENT_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.meterId,
      input.tenantCompanyId,
      input.spaceId,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<UtilityMeterTenantAssignmentRecord | null> {
  const result = await getPool().query<UtilityMeterTenantAssignmentRecord>(
    `SELECT ${ASSIGNMENT_SELECT} FROM utility_meter_tenant_assignments
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** The live tenant assignment of a Meter, if any. */
async function findActiveByMeter(
  meterId: string,
): Promise<UtilityMeterTenantAssignmentRecord | null> {
  const result = await getPool().query<UtilityMeterTenantAssignmentRecord>(
    `SELECT ${ASSIGNMENT_SELECT} FROM utility_meter_tenant_assignments
     WHERE meter_id = $1 AND status = 'ACTIVE'`,
    [meterId],
  );
  return result.rows[0] ?? null;
}

function listQuery(
  column: 'meter_id' | 'tenant_company_id' | 'space_id',
  value: string,
  filters: UtilityMeterTenantAssignmentFilters,
): { text: string; values: unknown[] } {
  const conditions = [`${column} = $1`];
  const values: unknown[] = [value];

  if (filters.status) {
    conditions.push('status = $2');
    values.push(filters.status);
  }

  return {
    text: `SELECT ${ASSIGNMENT_SELECT} FROM utility_meter_tenant_assignments
           WHERE ${conditions.join(' AND ')}
           ORDER BY (status = 'ACTIVE') DESC, created_at DESC`,
    values,
  };
}

/** Every assignment ever recorded for a Meter — the history view. */
async function listByMeter(
  meterId: string,
  filters: UtilityMeterTenantAssignmentFilters = {},
): Promise<UtilityMeterTenantAssignmentRecord[]> {
  const { text, values } = listQuery('meter_id', meterId, filters);
  const result = await getPool().query<UtilityMeterTenantAssignmentRecord>(
    text,
    values,
  );
  return result.rows;
}

/**
 * Assignments of a Tenant Company, restricted to the Buildings the actor can
 * access. Scoping happens in SQL rather than after the fetch.
 */
async function listByTenantCompany(
  tenantCompanyId: string,
  buildingIds: readonly string[] | null,
  filters: UtilityMeterTenantAssignmentFilters = {},
): Promise<UtilityMeterTenantAssignmentRecord[]> {
  const conditions = ['tenant_company_id = $1'];
  const values: unknown[] = [tenantCompanyId];
  let index = 2;

  if (filters.status) {
    conditions.push(`status = $${index++}`);
    values.push(filters.status);
  }
  if (buildingIds !== null) {
    if (buildingIds.length === 0) {
      return [];
    }
    conditions.push(`building_id = ANY($${index++}::uuid[])`);
    values.push([...buildingIds]);
  }

  const result = await getPool().query<UtilityMeterTenantAssignmentRecord>(
    `SELECT ${ASSIGNMENT_SELECT} FROM utility_meter_tenant_assignments
     WHERE ${conditions.join(' AND ')}
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC`,
    values,
  );
  return result.rows;
}

async function listBySpace(
  spaceId: string,
  filters: UtilityMeterTenantAssignmentFilters = {},
): Promise<UtilityMeterTenantAssignmentRecord[]> {
  const { text, values } = listQuery('space_id', spaceId, filters);
  const result = await getPool().query<UtilityMeterTenantAssignmentRecord>(
    text,
    values,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateUtilityMeterTenantAssignmentInput,
): Promise<UtilityMeterTenantAssignmentRecord | null> {
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

  const result = await getPool().query<UtilityMeterTenantAssignmentRecord>(
    `UPDATE utility_meter_tenant_assignments SET ${sets.join(', ')}
     WHERE id = $${index}
     RETURNING ${ASSIGNMENT_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

export const utilityMeterTenantRepository = {
  create,
  findActiveByMeter,
  findById,
  listByMeter,
  listBySpace,
  listByTenantCompany,
  update,
};
