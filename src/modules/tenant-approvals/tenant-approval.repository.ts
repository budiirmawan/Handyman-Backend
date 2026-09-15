import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantApproval,
  TenantApprovalPendingFilters,
  TenantApprovalRecord,
  TenantApprovalStatus,
} from './tenant-approval.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", building_id AS "buildingId",
  request_type AS "requestType", service_request_id AS "serviceRequestId",
  complaint_id AS "complaintId", utility_request_id AS "utilityRequestId",
  utility_calculation_id AS "utilityCalculationId",
  utility_snapshot_version AS "utilitySnapshotVersion",
  utility_space_id AS "utilitySpaceId", utility_meter_id AS "utilityMeterId",
  utility_meter_purpose AS "utilityMeterPurpose", utility_type AS "utilityType",
  utility_period_start AS "utilityPeriodStart", utility_period_end AS "utilityPeriodEnd",
  utility_consumption_quantity::text AS "utilityConsumptionQuantity",
  utility_uom_id AS "utilityUomId", utility_tariff_id AS "utilityTariffId",
  utility_tariff_rate::text AS "utilityTariffRate",
  utility_calculated_amount::text AS "utilityCalculatedAmount",
  utility_currency AS "utilityCurrency",
  approval_type AS "approvalType", approver_user_id AS "approverUserId",
  status, decided_at AS "decidedAt", decision_notes AS "decisionNotes",
  created_by_user_id AS "createdByUserId", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function create(input: NewTenantApproval): Promise<TenantApprovalRecord> {
  const result = await getPool().query<TenantApprovalRecord>(
    `INSERT INTO tenant_approval_bindings
       (id, client_id, tenant_company_id, building_id, request_type,
        service_request_id, complaint_id, utility_request_id,
        utility_calculation_id, utility_space_id, utility_meter_id,
        utility_meter_purpose, utility_type, utility_period_start,
        utility_period_end, utility_consumption_quantity, utility_uom_id,
        utility_tariff_id, utility_tariff_rate, utility_calculated_amount,
        utility_currency, approval_type, approver_user_id, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22,$23,$24) RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.tenantCompanyId, input.buildingId,
      input.requestType, input.serviceRequestId, input.complaintId,
      input.utilityRequestId, input.utilityCalculationId, input.utilitySpaceId,
      input.utilityMeterId, input.utilityMeterPurpose, input.utilityType,
      input.utilityPeriodStart, input.utilityPeriodEnd,
      input.utilityConsumptionQuantity, input.utilityUomId, input.utilityTariffId,
      input.utilityTariffRate, input.utilityCalculatedAmount, input.utilityCurrency,
      input.approvalType, input.approverUserId, input.createdByUserId],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantApprovalRecord | null> {
  const result = await getPool().query<TenantApprovalRecord>(
    `SELECT ${SELECT} FROM tenant_approval_bindings WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findPendingDuplicate(input: {
  requestType: string;
  requestId: string;
  approvalType: string;
  approverUserId: string;
}): Promise<TenantApprovalRecord | null> {
  const column = input.requestType === 'SERVICE_REQUEST'
    ? 'service_request_id'
    : input.requestType === 'COMPLAINT'
      ? 'complaint_id'
      : input.requestType === 'UTILITY_CALCULATION'
        ? 'utility_calculation_id'
        : 'utility_request_id';
  const result = await getPool().query<TenantApprovalRecord>(
    `SELECT ${SELECT} FROM tenant_approval_bindings
     WHERE ${column} = $1 AND approval_type = $2 AND approver_user_id = $3
       AND status = 'PENDING'`,
    [input.requestId, input.approvalType, input.approverUserId],
  );
  return result.rows[0] ?? null;
}

async function listPending(
  filters: TenantApprovalPendingFilters,
  buildingIds: string[],
): Promise<TenantApprovalRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ["status = 'PENDING'", 'building_id = ANY($1::uuid[])'];
  const fields: [keyof TenantApprovalPendingFilters, string][] = [
    ['buildingId', 'building_id'], ['tenantCompanyId', 'tenant_company_id'],
    ['requestType', 'request_type'], ['approvalType', 'approval_type'],
    ['approverUserId', 'approver_user_id'],
    ['utilityCalculationId', 'utility_calculation_id'],
  ];
  for (const [key, column] of fields) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  const result = await getPool().query<TenantApprovalRecord>(
    `SELECT ${SELECT} FROM tenant_approval_bindings
     WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`, values,
  );
  return result.rows;
}

/** BE-18L — every binding raised against one utility calculation. */
async function listByUtilityCalculation(
  utilityCalculationId: string,
): Promise<TenantApprovalRecord[]> {
  const result = await getPool().query<TenantApprovalRecord>(
    `SELECT ${SELECT} FROM tenant_approval_bindings
     WHERE utility_calculation_id = $1 ORDER BY created_at ASC`,
    [utilityCalculationId],
  );
  return result.rows;
}

async function decide(
  id: string,
  status: Exclude<TenantApprovalStatus, 'PENDING'>,
  decisionNotes: string | null,
): Promise<TenantApprovalRecord | null> {
  const result = await getPool().query<TenantApprovalRecord>(
    `UPDATE tenant_approval_bindings
     SET status = $2, decided_at = NOW(), decision_notes = $3, updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING' RETURNING ${SELECT}`,
    [id, status, decisionNotes],
  );
  return result.rows[0] ?? null;
}

async function findLatestByUtilityCalculation(
  utilityCalculationId: string,
): Promise<TenantApprovalRecord | null> {
  const result = await getPool().query<TenantApprovalRecord>(
    `SELECT ${SELECT} FROM tenant_approval_bindings
     WHERE utility_calculation_id = $1
     ORDER BY CASE WHEN status = 'PENDING' THEN 0 ELSE 1 END,
       updated_at DESC, created_at DESC, id DESC LIMIT 1`,
    [utilityCalculationId],
  );
  return result.rows[0] ?? null;
}

export const tenantApprovalRepository = {
  create,
  decide,
  findById,
  findLatestByUtilityCalculation,
  findPendingDuplicate,
  listByUtilityCalculation,
  listPending,
};
