import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantSpaceRelationship,
  TenantSpaceRelationshipRecord,
  UpdateTenantSpaceRelationshipInput,
} from './tenant-space.types';

const SELECT = `id, tenant_company_id AS "tenantCompanyId",
  building_id AS "buildingId", space_id AS "spaceId",
  effective_from AS "effectiveFrom", effective_until AS "effectiveUntil",
  status, created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewTenantSpaceRelationship): Promise<TenantSpaceRelationshipRecord> {
  const result = await getPool().query<TenantSpaceRelationshipRecord>(
    `INSERT INTO tenant_space_relationships
       (id, tenant_company_id, building_id, space_id,
        effective_from, effective_until, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${SELECT}`,
    [randomUUID(), input.tenantCompanyId, input.buildingId, input.spaceId,
      input.effectiveFrom, input.effectiveUntil, input.status],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantSpaceRelationshipRecord | null> {
  const result = await getPool().query<TenantSpaceRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_space_relationships WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveBySpace(spaceId: string): Promise<TenantSpaceRelationshipRecord | null> {
  const result = await getPool().query<TenantSpaceRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_space_relationships
     WHERE space_id = $1 AND status = 'ACTIVE'`, [spaceId],
  );
  return result.rows[0] ?? null;
}

async function findActiveByTenantBuildingAndSpace(
  tenantCompanyId: string,
  buildingId: string,
  spaceId: string,
): Promise<TenantSpaceRelationshipRecord | null> {
  const result = await getPool().query<TenantSpaceRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_space_relationships
     WHERE tenant_company_id = $1 AND building_id = $2 AND space_id = $3
       AND status = 'ACTIVE'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantCompanyId, buildingId, spaceId],
  );
  return result.rows[0] ?? null;
}

async function findActiveByTenantAndBuilding(
  tenantCompanyId: string,
  buildingId: string,
): Promise<TenantSpaceRelationshipRecord | null> {
  const result = await getPool().query<TenantSpaceRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_space_relationships
     WHERE tenant_company_id = $1 AND building_id = $2 AND status = 'ACTIVE'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantCompanyId, buildingId],
  );
  return result.rows[0] ?? null;
}

async function listByTenantCompany(
  tenantCompanyId: string,
  buildingIds: string[],
): Promise<TenantSpaceRelationshipRecord[]> {
  if (buildingIds.length === 0) return [];
  const result = await getPool().query<TenantSpaceRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_space_relationships
     WHERE tenant_company_id = $1 AND building_id = ANY($2::uuid[])
     ORDER BY created_at ASC`,
    [tenantCompanyId, buildingIds],
  );
  return result.rows;
}

async function listByBuilding(buildingId: string): Promise<TenantSpaceRelationshipRecord[]> {
  const result = await getPool().query<TenantSpaceRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_space_relationships
     WHERE building_id = $1 ORDER BY created_at ASC`, [buildingId],
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateTenantSpaceRelationshipInput,
): Promise<TenantSpaceRelationshipRecord | null> {
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
  const result = await getPool().query<TenantSpaceRelationshipRecord>(
    `UPDATE tenant_space_relationships SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

export const tenantSpaceRepository = {
  create,
  findActiveBySpace,
  findActiveByTenantAndBuilding,
  findActiveByTenantBuildingAndSpace,
  findById,
  listByBuilding,
  listByTenantCompany,
  update,
};
