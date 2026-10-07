import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantUtilityRequest,
  TenantUtilityRequestFilters,
  TenantUtilityRequestRecord,
  UpdateTenantUtilityRequestInput,
} from './tenant-utility-request.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", tenant_pic_id AS "tenantPicId",
  building_id AS "buildingId", space_id AS "spaceId",
  utility_type AS "utilityType", request_number AS "requestNumber",
  request_details AS "requestDetails", requested_at AS "requestedAt",
  status, notes, work_request_id AS "workRequestId",
  work_order_id AS "workOrderId", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function create(input: NewTenantUtilityRequest): Promise<TenantUtilityRequestRecord> {
  const result = await getPool().query<TenantUtilityRequestRecord>(
    `INSERT INTO tenant_utility_requests
       (id, client_id, tenant_company_id, tenant_pic_id, building_id, space_id,
        utility_type, request_number, request_details, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.tenantCompanyId, input.tenantPicId,
      input.buildingId, input.spaceId, input.utilityType, input.requestNumber,
      input.requestDetails, input.notes],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantUtilityRequestRecord | null> {
  const result = await getPool().query<TenantUtilityRequestRecord>(
    `SELECT ${SELECT} FROM tenant_utility_requests WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findByNumber(clientId: string, requestNumber: string): Promise<TenantUtilityRequestRecord | null> {
  const result = await getPool().query<TenantUtilityRequestRecord>(
    `SELECT ${SELECT} FROM tenant_utility_requests
     WHERE client_id = $1 AND request_number = $2`, [clientId, requestNumber],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: TenantUtilityRequestFilters,
  buildingIds: string[],
): Promise<TenantUtilityRequestRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];
  const fields: [keyof TenantUtilityRequestFilters, string][] = [
    ['tenantCompanyId', 'tenant_company_id'], ['buildingId', 'building_id'],
    ['status', 'status'], ['utilityType', 'utility_type'],
  ];
  for (const [key, column] of fields) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  const result = await getPool().query<TenantUtilityRequestRecord>(
    `SELECT ${SELECT} FROM tenant_utility_requests
     WHERE ${clauses.join(' AND ')} ORDER BY requested_at DESC`, values,
  );
  return result.rows;
}

async function update(id: string, input: UpdateTenantUtilityRequestInput): Promise<TenantUtilityRequestRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdateTenantUtilityRequestInput, string][] = [
    ['utilityType', 'utility_type'], ['requestDetails', 'request_details'],
    ['notes', 'notes'],
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
  const result = await getPool().query<TenantUtilityRequestRecord>(
    `UPDATE tenant_utility_requests SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`, values,
  );
  return result.rows[0] ?? null;
}

async function cancel(id: string): Promise<TenantUtilityRequestRecord | null> {
  const result = await getPool().query<TenantUtilityRequestRecord>(
    `UPDATE tenant_utility_requests SET status = 'CANCELLED', updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`, [id],
  );
  return result.rows[0] ?? null;
}
async function bindWorkRequest(id: string, workRequestId: string): Promise<TenantUtilityRequestRecord | null> {
  const result = await getPool().query<TenantUtilityRequestRecord>(
    `UPDATE tenant_utility_requests
     SET work_request_id = $2, status = 'CONVERTED', updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`, [id, workRequestId],
  );
  return result.rows[0] ?? null;
}
async function bindWorkOrder(id: string, workOrderId: string): Promise<TenantUtilityRequestRecord | null> {
  const result = await getPool().query<TenantUtilityRequestRecord>(
    `UPDATE tenant_utility_requests SET work_order_id = $2, updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`, [id, workOrderId],
  );
  return result.rows[0] ?? null;
}

export const tenantUtilityRequestRepository = {
  bindWorkOrder, bindWorkRequest, cancel, create, findById, findByNumber, list, update,
};
