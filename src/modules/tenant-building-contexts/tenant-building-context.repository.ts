import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantBuildingContext,
  TenantBuildingContextRecord,
  UpdateTenantBuildingContextInput,
} from './tenant-building-context.types';

const SELECT = `id, tenant_company_id AS "tenantCompanyId",
  building_id AS "buildingId", effective_from AS "effectiveFrom",
  effective_until AS "effectiveUntil", status,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewTenantBuildingContext): Promise<TenantBuildingContextRecord> {
  const result = await getPool().query<TenantBuildingContextRecord>(
    `INSERT INTO tenant_building_contexts
       (id, tenant_company_id, building_id, effective_from, effective_until, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${SELECT}`,
    [randomUUID(), input.tenantCompanyId, input.buildingId,
      input.effectiveFrom, input.effectiveUntil, input.status],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantBuildingContextRecord | null> {
  const result = await getPool().query<TenantBuildingContextRecord>(
    `SELECT ${SELECT} FROM tenant_building_contexts WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findActive(
  tenantCompanyId: string,
  buildingId: string,
): Promise<TenantBuildingContextRecord | null> {
  const result = await getPool().query<TenantBuildingContextRecord>(
    `SELECT ${SELECT} FROM tenant_building_contexts
     WHERE tenant_company_id = $1 AND building_id = $2 AND status = 'ACTIVE'`,
    [tenantCompanyId, buildingId],
  );
  return result.rows[0] ?? null;
}

async function listByTenantCompany(
  tenantCompanyId: string,
  buildingIds: string[],
): Promise<TenantBuildingContextRecord[]> {
  if (buildingIds.length === 0) return [];
  const result = await getPool().query<TenantBuildingContextRecord>(
    `SELECT ${SELECT} FROM tenant_building_contexts
     WHERE tenant_company_id = $1 AND building_id = ANY($2::uuid[])
     ORDER BY created_at ASC`,
    [tenantCompanyId, buildingIds],
  );
  return result.rows;
}

async function listByBuilding(buildingId: string): Promise<TenantBuildingContextRecord[]> {
  const result = await getPool().query<TenantBuildingContextRecord>(
    `SELECT ${SELECT} FROM tenant_building_contexts
     WHERE building_id = $1 ORDER BY created_at ASC`, [buildingId],
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateTenantBuildingContextInput,
): Promise<TenantBuildingContextRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  if (input.effectiveFrom !== undefined) {
    values.push(input.effectiveFrom);
    sets.push(`effective_from = $${values.length}`);
  }
  if (input.effectiveUntil !== undefined) {
    values.push(input.effectiveUntil);
    sets.push(`effective_until = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<TenantBuildingContextRecord>(
    `UPDATE tenant_building_contexts SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

export const tenantBuildingContextRepository = {
  create,
  findActive,
  findById,
  listByBuilding,
  listByTenantCompany,
  update,
};
