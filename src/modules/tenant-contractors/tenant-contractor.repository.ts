import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantContractorRelationship,
  TenantContractorRelationshipFilters,
  TenantContractorRelationshipRecord,
  UpdateTenantContractorRelationshipInput,
} from './tenant-contractor.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId",
  contractor_vendor_id AS "contractorVendorId",
  building_id AS "buildingId", space_id AS "spaceId",
  relationship_type AS "relationshipType",
  effective_from AS "effectiveFrom", effective_until AS "effectiveUntil",
  status, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewTenantContractorRelationship): Promise<TenantContractorRelationshipRecord> {
  const result = await getPool().query<TenantContractorRelationshipRecord>(
    `INSERT INTO tenant_contractor_relationships
       (id, client_id, tenant_company_id, contractor_vendor_id, building_id,
        space_id, relationship_type, effective_from, effective_until, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.tenantCompanyId,
      input.contractorVendorId, input.buildingId, input.spaceId,
      input.relationshipType, input.effectiveFrom, input.effectiveUntil,
      input.status, input.notes],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantContractorRelationshipRecord | null> {
  const result = await getPool().query<TenantContractorRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_contractor_relationships WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveDuplicate(input: {
  tenantCompanyId: string;
  contractorVendorId: string;
  buildingId: string;
  spaceId: string | null;
  relationshipType: string;
}): Promise<TenantContractorRelationshipRecord | null> {
  const result = await getPool().query<TenantContractorRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_contractor_relationships
     WHERE tenant_company_id = $1 AND contractor_vendor_id = $2
       AND building_id = $3 AND space_id IS NOT DISTINCT FROM $4
       AND relationship_type = $5 AND status = 'ACTIVE'`,
    [input.tenantCompanyId, input.contractorVendorId, input.buildingId,
      input.spaceId, input.relationshipType],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: TenantContractorRelationshipFilters,
  buildingIds: string[],
): Promise<TenantContractorRelationshipRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];
  const fields: [keyof TenantContractorRelationshipFilters, string][] = [
    ['tenantCompanyId', 'tenant_company_id'], ['buildingId', 'building_id'],
    ['contractorVendorId', 'contractor_vendor_id'],
    ['relationshipType', 'relationship_type'], ['status', 'status'],
  ];
  for (const [key, column] of fields) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  const result = await getPool().query<TenantContractorRelationshipRecord>(
    `SELECT ${SELECT} FROM tenant_contractor_relationships
     WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`, values,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateTenantContractorRelationshipInput,
): Promise<TenantContractorRelationshipRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdateTenantContractorRelationshipInput, string][] = [
    ['effectiveFrom', 'effective_from'], ['effectiveUntil', 'effective_until'],
    ['status', 'status'], ['notes', 'notes'],
  ];
  for (const [key, column] of fields) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<TenantContractorRelationshipRecord>(
    `UPDATE tenant_contractor_relationships SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`, values,
  );
  return result.rows[0] ?? null;
}

export const tenantContractorRepository = {
  create,
  findActiveDuplicate,
  findById,
  list,
  update,
};
