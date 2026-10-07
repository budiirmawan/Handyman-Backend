import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantServiceRequest,
  TenantServiceRequestFilters,
  TenantServiceRequestRecord,
  UpdateTenantServiceRequestInput,
} from './tenant-service-request.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", tenant_pic_id AS "tenantPicId",
  building_id AS "buildingId", space_id AS "spaceId",
  intake_channel AS "intakeChannel",
  created_by_user_id AS "createdByUserId",
  reporter_name AS "reporterName", reporter_phone AS "reporterPhone",
  reporter_email AS "reporterEmail",
  request_number AS "requestNumber", request_type AS "requestType",
  title, description, priority, status, requested_at AS "requestedAt",
  work_request_id AS "workRequestId", work_order_id AS "workOrderId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewTenantServiceRequest): Promise<TenantServiceRequestRecord> {
  const result = await getPool().query<TenantServiceRequestRecord>(
    `INSERT INTO tenant_service_requests
       (id, client_id, tenant_company_id, tenant_pic_id, building_id, space_id,
        intake_channel, created_by_user_id, reporter_name, reporter_phone,
        reporter_email, request_number, request_type, title, description,
        priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.tenantCompanyId, input.tenantPicId,
      input.buildingId, input.spaceId,
      input.intakeChannel ?? null, input.createdByUserId ?? null,
      input.reporterName ?? null, input.reporterPhone ?? null,
      input.reporterEmail ?? null,
      input.requestNumber, input.requestType, input.title, input.description,
      input.priority],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantServiceRequestRecord | null> {
  const result = await getPool().query<TenantServiceRequestRecord>(
    `SELECT ${SELECT} FROM tenant_service_requests WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findByNumber(
  clientId: string,
  requestNumber: string,
): Promise<TenantServiceRequestRecord | null> {
  const result = await getPool().query<TenantServiceRequestRecord>(
    `SELECT ${SELECT} FROM tenant_service_requests
     WHERE client_id = $1 AND request_number = $2`, [clientId, requestNumber],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: TenantServiceRequestFilters,
  accessibleBuildingIds: string[],
): Promise<TenantServiceRequestRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];
  const fields: [keyof TenantServiceRequestFilters, string][] = [
    ['tenantCompanyId', 'tenant_company_id'],
    ['buildingId', 'building_id'],
    ['status', 'status'],
    ['requestType', 'request_type'],
  ];
  for (const [key, column] of fields) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  const result = await getPool().query<TenantServiceRequestRecord>(
    `SELECT ${SELECT} FROM tenant_service_requests
     WHERE ${clauses.join(' AND ')} ORDER BY requested_at DESC`,
    values,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateTenantServiceRequestInput,
): Promise<TenantServiceRequestRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdateTenantServiceRequestInput, string][] = [
    ['requestType', 'request_type'], ['title', 'title'],
    ['description', 'description'], ['priority', 'priority'],
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
  const result = await getPool().query<TenantServiceRequestRecord>(
    `UPDATE tenant_service_requests SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function cancel(id: string): Promise<TenantServiceRequestRecord | null> {
  const result = await getPool().query<TenantServiceRequestRecord>(
    `UPDATE tenant_service_requests SET status = 'CANCELLED', updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`, [id],
  );
  return result.rows[0] ?? null;
}

async function bindWorkRequest(
  id: string,
  workRequestId: string,
): Promise<TenantServiceRequestRecord | null> {
  const result = await getPool().query<TenantServiceRequestRecord>(
    `UPDATE tenant_service_requests
     SET work_request_id = $2, status = 'CONVERTED', updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`,
    [id, workRequestId],
  );
  return result.rows[0] ?? null;
}

async function bindWorkOrder(
  id: string,
  workOrderId: string,
): Promise<TenantServiceRequestRecord | null> {
  const result = await getPool().query<TenantServiceRequestRecord>(
    `UPDATE tenant_service_requests
     SET work_order_id = $2, updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`,
    [id, workOrderId],
  );
  return result.rows[0] ?? null;
}

export const tenantServiceRequestRepository = {
  bindWorkOrder,
  bindWorkRequest,
  cancel,
  create,
  findById,
  findByNumber,
  list,
  update,
};
