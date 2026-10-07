import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  NewProcurementApproval,
  ProcurementApprovalPendingFilters,
  ProcurementApprovalRecord,
  ProcurementApprovalStatus,
} from './procurement-approval.types';

const SELECT = `id, client_id AS "clientId", building_id AS "buildingId",
  request_type AS "requestType", purchase_request_id AS "purchaseRequestId",
  material_request_id AS "materialRequestId", service_request_id AS "serviceRequestId",
  rfq_id AS "rfqId", recommendation_id AS "recommendationId",
  approval_type AS "approvalType", approver_user_id AS "approverUserId",
  status, decided_at AS "decidedAt", decision_notes AS "decisionNotes",
  created_by_user_id AS "createdByUserId", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function create(
  input: NewProcurementApproval,
): Promise<ProcurementApprovalRecord> {
  const result = await getPool().query<ProcurementApprovalRecord>(
    `INSERT INTO procurement_approval_bindings
       (id, client_id, building_id, request_type, purchase_request_id,
        material_request_id, service_request_id, rfq_id, recommendation_id,
        approval_type, approver_user_id, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.requestType,
      input.purchaseRequestId,
      input.materialRequestId,
      input.serviceRequestId,
      input.rfqId,
      input.recommendationId,
      input.approvalType,
      input.approverUserId,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<ProcurementApprovalRecord | null> {
  const result = await getPool().query<ProcurementApprovalRecord>(
    `SELECT ${SELECT} FROM procurement_approval_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findPendingDuplicate(input: {
  requestType: string;
  requestId: string;
  approvalType: string;
  approverUserId: string;
}): Promise<ProcurementApprovalRecord | null> {
  const column = requestColumn(input.requestType);
  const result = await getPool().query<ProcurementApprovalRecord>(
    `SELECT ${SELECT} FROM procurement_approval_bindings
     WHERE ${column} = $1 AND approval_type = $2 AND approver_user_id = $3
       AND status = 'PENDING'`,
    [input.requestId, input.approvalType, input.approverUserId],
  );
  return result.rows[0] ?? null;
}

async function listPending(
  filters: ProcurementApprovalPendingFilters,
  buildingIds: string[],
): Promise<ProcurementApprovalRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ["status = 'PENDING'", 'building_id = ANY($1::uuid[])'];

  if (filters.buildingId !== undefined) {
    values.push(filters.buildingId);
    clauses.push(`building_id = $${values.length}`);
  }
  if (filters.requestType !== undefined) {
    values.push(filters.requestType);
    clauses.push(`request_type = $${values.length}`);
  }
  if (filters.approvalType !== undefined) {
    values.push(filters.approvalType);
    clauses.push(`approval_type = $${values.length}`);
  }
  if (filters.approverUserId !== undefined) {
    values.push(filters.approverUserId);
    clauses.push(`approver_user_id = $${values.length}`);
  }

  const result = await getPool().query<ProcurementApprovalRecord>(
    `SELECT ${SELECT} FROM procurement_approval_bindings
     WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`,
    values,
  );
  return result.rows;
}

async function decide(
  id: string,
  status: Exclude<ProcurementApprovalStatus, 'PENDING'>,
  decisionNotes: string | null,
): Promise<ProcurementApprovalRecord | null> {
  return decideWith(getPool(), id, status, decisionNotes);
}

/**
 * CR-BE-MAT-01 PART 02 — transaction-aware decide, so the approval decision
 * and the Material Request approval application commit atomically.
 */
async function decideWithClient(
  client: PoolClient,
  id: string,
  status: Exclude<ProcurementApprovalStatus, 'PENDING'>,
  decisionNotes: string | null,
): Promise<ProcurementApprovalRecord | null> {
  return decideWith(client, id, status, decisionNotes);
}

async function decideWith(
  queryable: Pool | PoolClient,
  id: string,
  status: Exclude<ProcurementApprovalStatus, 'PENDING'>,
  decisionNotes: string | null,
): Promise<ProcurementApprovalRecord | null> {
  const result = await queryable.query<ProcurementApprovalRecord>(
    `UPDATE procurement_approval_bindings
     SET status = $2, decided_at = NOW(), decision_notes = $3, updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING' RETURNING ${SELECT}`,
    [id, status, decisionNotes],
  );
  return result.rows[0] ?? null;
}

function requestColumn(requestType: string): string {
  switch (requestType) {
    case 'PURCHASE_REQUEST':
      return 'purchase_request_id';
    case 'MATERIAL_REQUEST':
      return 'material_request_id';
    case 'SERVICE_REQUEST':
      return 'service_request_id';
    case 'RFQ':
      return 'rfq_id';
    default:
      throw new Error(`Unknown procurement request type: ${requestType}`);
  }
}

export const procurementApprovalRepository = {
  create,
  decide,
  decideWithClient,
  findById,
  findPendingDuplicate,
  listPending,
};
