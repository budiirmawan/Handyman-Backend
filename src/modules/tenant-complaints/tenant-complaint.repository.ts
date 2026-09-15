import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantComplaint,
  TenantComplaintFilters,
  TenantComplaintRecord,
  UpdateTenantComplaintInput,
} from './tenant-complaint.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", tenant_pic_id AS "tenantPicId",
  building_id AS "buildingId", space_id AS "spaceId",
  complaint_number AS "complaintNumber", complaint_type AS "complaintType",
  title, description, severity, status, reported_at AS "reportedAt",
  finding_id AS "findingId", work_order_id AS "workOrderId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewTenantComplaint): Promise<TenantComplaintRecord> {
  const result = await getPool().query<TenantComplaintRecord>(
    `INSERT INTO tenant_complaints
       (id, client_id, tenant_company_id, tenant_pic_id, building_id, space_id,
        complaint_number, complaint_type, title, description, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.tenantCompanyId, input.tenantPicId,
      input.buildingId, input.spaceId, input.complaintNumber, input.complaintType,
      input.title, input.description, input.severity],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantComplaintRecord | null> {
  const result = await getPool().query<TenantComplaintRecord>(
    `SELECT ${SELECT} FROM tenant_complaints WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findByNumber(clientId: string, complaintNumber: string): Promise<TenantComplaintRecord | null> {
  const result = await getPool().query<TenantComplaintRecord>(
    `SELECT ${SELECT} FROM tenant_complaints
     WHERE client_id = $1 AND complaint_number = $2`, [clientId, complaintNumber],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: TenantComplaintFilters,
  accessibleBuildingIds: string[],
): Promise<TenantComplaintRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];
  const fields: [keyof TenantComplaintFilters, string][] = [
    ['tenantCompanyId', 'tenant_company_id'], ['buildingId', 'building_id'],
    ['status', 'status'], ['complaintType', 'complaint_type'],
  ];
  for (const [key, column] of fields) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  const result = await getPool().query<TenantComplaintRecord>(
    `SELECT ${SELECT} FROM tenant_complaints
     WHERE ${clauses.join(' AND ')} ORDER BY reported_at DESC`, values,
  );
  return result.rows;
}

async function update(id: string, input: UpdateTenantComplaintInput): Promise<TenantComplaintRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdateTenantComplaintInput, string][] = [
    ['complaintType', 'complaint_type'], ['title', 'title'],
    ['description', 'description'], ['severity', 'severity'],
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
  const result = await getPool().query<TenantComplaintRecord>(
    `UPDATE tenant_complaints SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`, values,
  );
  return result.rows[0] ?? null;
}

async function cancel(id: string): Promise<TenantComplaintRecord | null> {
  const result = await getPool().query<TenantComplaintRecord>(
    `UPDATE tenant_complaints SET status = 'CANCELLED', updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`, [id],
  );
  return result.rows[0] ?? null;
}

async function bindFinding(id: string, findingId: string): Promise<TenantComplaintRecord | null> {
  const result = await getPool().query<TenantComplaintRecord>(
    `UPDATE tenant_complaints
     SET finding_id = $2, status = 'ESCALATED', updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`, [id, findingId],
  );
  return result.rows[0] ?? null;
}

async function bindWorkOrder(id: string, workOrderId: string): Promise<TenantComplaintRecord | null> {
  const result = await getPool().query<TenantComplaintRecord>(
    `UPDATE tenant_complaints SET work_order_id = $2, updated_at = NOW()
     WHERE id = $1 RETURNING ${SELECT}`, [id, workOrderId],
  );
  return result.rows[0] ?? null;
}

export const tenantComplaintRepository = {
  bindFinding,
  bindWorkOrder,
  cancel,
  create,
  findById,
  findByNumber,
  list,
  update,
};
