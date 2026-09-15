import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPermitWorker,
  PermitWorkerFilters,
  PermitWorkerRecord,
  UpdatePermitWorkerInput,
} from './permit-worker.types';

const SELECT = `
  pw.id,
  pw.permit_application_id AS "permitApplicationId",
  pa.permit_id AS "permitId",
  p.permit_number AS "permitReference",
  p.client_id AS "clientId",
  p.building_id AS "buildingId",
  p.contractor_context_type AS "contractorContextType",
  COALESCE(
    p.tenant_contractor_relationship_id,
    p.contractor_vendor_id
  ) AS "contractorContextId",
  p.contractor_vendor_id AS "contractorVendorId",
  pw.vendor_workforce_binding_id AS "vendorWorkforceBindingId",
  wp.id AS "workforceProfileId",
  wp.full_name AS "workerName",
  wp.employee_code AS "employeeCode",
  vwb.vendor_personnel_code AS "vendorPersonnelCode",
  wp.workforce_type AS "workforceType",
  wp.status AS "workforceStatus",
  vwb.status AS "vendorWorkforceStatus",
  vwb.effective_from AS "vendorWorkforceEffectiveFrom",
  vwb.effective_until AS "vendorWorkforceEffectiveUntil",
  pw.role_trade AS "roleTrade",
  pw.status,
  pw.valid_from AS "validFrom",
  pw.valid_until AS "validUntil",
  CASE
    WHEN pv.status = 'REVOKED' THEN 'REVOKED'
    WHEN pv.valid_until <= NOW() THEN 'EXPIRED'
    WHEN pv.valid_from <= NOW() THEN 'VALID'
    WHEN pv.id IS NOT NULL THEN 'PENDING'
    ELSE NULL
  END AS "permitValidityStatus",
  pw.notes,
  pw.created_by_user_id AS "createdByUserId",
  pw.updated_by_user_id AS "updatedByUserId",
  pw.deactivated_at AS "deactivatedAt",
  pw.deactivated_by_user_id AS "deactivatedByUserId",
  pw.created_at AS "createdAt",
  pw.updated_at AS "updatedAt"
`;

const JOINS = `
  FROM permit_workers pw
  JOIN permit_applications pa ON pa.id = pw.permit_application_id
  JOIN permits p ON p.id = pa.permit_id
  JOIN vendor_workforce_bindings vwb
    ON vwb.id = pw.vendor_workforce_binding_id
  JOIN workforce_profiles wp ON wp.id = vwb.workforce_profile_id
  LEFT JOIN LATERAL (
    SELECT latest.*
    FROM permit_validities latest
    WHERE latest.permit_application_id = pa.id
    ORDER BY latest.created_at DESC, latest.id DESC
    LIMIT 1
  ) pv ON TRUE
`;

async function create(input: NewPermitWorker): Promise<PermitWorkerRecord> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO permit_workers
       (id, permit_application_id, vendor_workforce_binding_id, role_trade,
        valid_from, valid_until, notes, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      id,
      input.permitApplicationId,
      input.vendorWorkforceBindingId,
      input.roleTrade,
      input.validFrom,
      input.validUntil,
      input.notes,
      input.actorUserId,
    ],
  );
  return (await findById(id)) as PermitWorkerRecord;
}

async function findById(id: string): Promise<PermitWorkerRecord | null> {
  const result = await getPool().query<PermitWorkerRecord>(
    `SELECT ${SELECT} ${JOINS} WHERE pw.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveDuplicate(
  permitApplicationId: string,
  vendorWorkforceBindingId: string,
): Promise<PermitWorkerRecord | null> {
  const result = await getPool().query<PermitWorkerRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE pw.permit_application_id = $1
       AND pw.vendor_workforce_binding_id = $2
       AND pw.status = 'ACTIVE'`,
    [permitApplicationId, vendorWorkforceBindingId],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: PermitWorkerFilters,
  accessibleBuildingIds: string[],
): Promise<PermitWorkerRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['p.building_id = ANY($1::uuid[])'];
  if (filters.permitId) {
    values.push(filters.permitId);
    conditions.push(`p.id = $${values.length}`);
  }
  if (filters.permitApplicationId) {
    values.push(filters.permitApplicationId);
    conditions.push(`pa.id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`p.building_id = $${values.length}`);
  }
  if (filters.contractorContextType) {
    values.push(filters.contractorContextType);
    conditions.push(`p.contractor_context_type = $${values.length}`);
  }
  if (filters.contractorContextId) {
    values.push(filters.contractorContextId);
    conditions.push(`(
      p.contractor_vendor_id = $${values.length}
      OR p.tenant_contractor_relationship_id = $${values.length}
    )`);
  }
  if (filters.contractorVendorId) {
    values.push(filters.contractorVendorId);
    conditions.push(`p.contractor_vendor_id = $${values.length}`);
  }
  if (filters.workforceProfileId) {
    values.push(filters.workforceProfileId);
    conditions.push(`wp.id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`pw.status = $${values.length}`);
  }
  const result = await getPool().query<PermitWorkerRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE ${conditions.join(' AND ')}
     ORDER BY pw.created_at, pw.id`,
    values,
  );
  return result.rows;
}

async function updateActive(
  id: string,
  input: UpdatePermitWorkerInput,
  actorUserId: string,
): Promise<PermitWorkerRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdatePermitWorkerInput, string][] = [
    ['roleTrade', 'role_trade'],
    ['validFrom', 'valid_from'],
    ['validUntil', 'valid_until'],
    ['notes', 'notes'],
  ];
  for (const [key, column] of fields) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  values.push(actorUserId);
  sets.push(`updated_by_user_id = $${values.length}`);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_workers SET ${sets.join(', ')}
     WHERE id = $${values.length} AND status = 'ACTIVE'
     RETURNING id`,
    values,
  );
  return result.rows[0] ? findById(id) : null;
}

async function deactivate(
  id: string,
  actorUserId: string,
): Promise<PermitWorkerRecord | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_workers
     SET status = 'INACTIVE', deactivated_at = NOW(),
         deactivated_by_user_id = $2, updated_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING id`,
    [id, actorUserId],
  );
  return result.rows[0] ? findById(id) : null;
}

export const permitWorkerRepository = {
  create,
  deactivate,
  findActiveDuplicate,
  findById,
  list,
  updateActive,
};
