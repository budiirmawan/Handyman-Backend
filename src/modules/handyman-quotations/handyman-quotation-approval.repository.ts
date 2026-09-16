import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationApprovalRecord,
  HandymanQuotationApprovedForType,
  HandymanQuotationApprovalRuntimeMethod,
} from './handyman-quotation-approval.types';

/**
 * CR-HM-BE-03 RUN 3 — Approval persistence.
 *
 * PENDING rows are created only by the governed send composition (exact sent
 * revision); every decision/expiration is a guarded UPDATE with the
 * `status = 'PENDING'` precondition so concurrent decide races have exactly
 * one winner. At most one PENDING approval per revision is structurally
 * enforced by the migration-0352 partial unique index.
 */

const APPROVAL_SELECT = `
  id,
  quotation_id AS "quotationId",
  quotation_revision_id AS "quotationRevisionId",
  client_id AS "clientId",
  building_id AS "buildingId",
  status,
  method,
  approved_for_type AS "approvedForType",
  approved_for_tenant_company_id AS "approvedForTenantCompanyId",
  approved_for_tenant_pic_id AS "approvedForTenantPicId",
  approved_for_name AS "approvedForName",
  approved_for_customer_name AS "approvedForCustomerName",
  approved_for_customer_phone AS "approvedForCustomerPhone",
  approved_for_customer_email AS "approvedForCustomerEmail",
  decision_notes AS "decisionNotes",
  recorded_by_user_id AS "recordedByUserId",
  decided_at AS "decidedAt",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export type ApprovalDecisionFields = {
  status: 'APPROVED' | 'REJECTED';
  method: HandymanQuotationApprovalRuntimeMethod;
  approvedForType: HandymanQuotationApprovedForType;
  approvedForTenantCompanyId: string | null;
  approvedForTenantPicId: string | null;
  approvedForName: string | null;
  approvedForCustomerName: string | null;
  approvedForCustomerPhone: string | null;
  approvedForCustomerEmail: string | null;
  decisionNotes: string | null;
  recordedByUserId: string | null;
};

async function createPending(
  input: {
    quotationId: string;
    quotationRevisionId: string;
    clientId: string;
    buildingId: string;
    createdByUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalRecord> {
  const result = await executor.query<HandymanQuotationApprovalRecord>(
    `INSERT INTO handyman_quotation_approvals
       (id, quotation_id, quotation_revision_id, client_id, building_id,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${APPROVAL_SELECT}`,
    [
      randomUUID(),
      input.quotationId,
      input.quotationRevisionId,
      input.clientId,
      input.buildingId,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalRecord>(
    `SELECT ${APPROVAL_SELECT} FROM handyman_quotation_approvals WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function lockById(
  id: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationApprovalRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalRecord>(
    `SELECT ${APPROVAL_SELECT} FROM handyman_quotation_approvals
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findPendingByRevision(
  quotationRevisionId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalRecord>(
    `SELECT ${APPROVAL_SELECT} FROM handyman_quotation_approvals
     WHERE quotation_revision_id = $1 AND status = 'PENDING'`,
    [quotationRevisionId],
  );
  return result.rows[0] ?? null;
}

/** Locks the PENDING approval of a revision (decide races serialize here). */
async function lockPendingByRevision(
  quotationRevisionId: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationApprovalRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalRecord>(
    `SELECT ${APPROVAL_SELECT} FROM handyman_quotation_approvals
     WHERE quotation_revision_id = $1 AND status = 'PENDING'
     FOR UPDATE`,
    [quotationRevisionId],
  );
  return result.rows[0] ?? null;
}

async function listByQuotation(
  quotationId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalRecord[]> {
  const result = await executor.query<HandymanQuotationApprovalRecord>(
    `SELECT ${APPROVAL_SELECT} FROM handyman_quotation_approvals
     WHERE quotation_id = $1
     ORDER BY created_at ASC, id ASC`,
    [quotationId],
  );
  return result.rows;
}

async function listByRevision(
  quotationRevisionId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalRecord[]> {
  const result = await executor.query<HandymanQuotationApprovalRecord>(
    `SELECT ${APPROVAL_SELECT} FROM handyman_quotation_approvals
     WHERE quotation_revision_id = $1
     ORDER BY created_at ASC, id ASC`,
    [quotationRevisionId],
  );
  return result.rows;
}

/** Guarded once-only decision: PENDING → APPROVED/REJECTED with the full
 * approved-for/recorded-by evidence set. Returns null when another command
 * already decided (or expired) the approval. */
async function decideFromPending(
  id: string,
  fields: ApprovalDecisionFields,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationApprovalRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalRecord>(
    `UPDATE handyman_quotation_approvals
     SET status = $2,
         method = $3,
         approved_for_type = $4,
         approved_for_tenant_company_id = $5,
         approved_for_tenant_pic_id = $6,
         approved_for_name = $7,
         approved_for_customer_name = $8,
         approved_for_customer_phone = $9,
         approved_for_customer_email = $10,
         decision_notes = $11,
         recorded_by_user_id = $12,
         decided_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING ${APPROVAL_SELECT}`,
    [
      id,
      fields.status,
      fields.method,
      fields.approvedForType,
      fields.approvedForTenantCompanyId,
      fields.approvedForTenantPicId,
      fields.approvedForName,
      fields.approvedForCustomerName,
      fields.approvedForCustomerPhone,
      fields.approvedForCustomerEmail,
      fields.decisionNotes,
      fields.recordedByUserId,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Guarded PENDING → EXPIRED for stale approvals: used when a quotation is
 * withdrawn or re-sent on a different revision, so exactly one PENDING
 * approval per quotation can exist and only for the bound sent revision.
 * EXPIRED is never a decision — method/approved-for stay NULL.
 */
async function expirePendingByQuotation(
  quotationId: string,
  executor: Pick<PoolClient, 'query'>,
  options: { exceptApprovalId?: string | null } = {},
): Promise<string[]> {
  const values: unknown[] = [quotationId];
  let exceptClause = '';
  if (options.exceptApprovalId) {
    values.push(options.exceptApprovalId);
    exceptClause = ` AND id <> $${values.length}`;
  }
  const result = await executor.query<{ id: string }>(
    `UPDATE handyman_quotation_approvals
     SET status = 'EXPIRED',
         decided_at = NOW(),
         updated_at = NOW()
     WHERE quotation_id = $1 AND status = 'PENDING'${exceptClause}
     RETURNING id`,
    values,
  );
  return result.rows.map((row) => row.id);
}

export const handymanQuotationApprovalRepository = {
  createPending,
  findById,
  lockById,
  findPendingByRevision,
  lockPendingByRevision,
  listByQuotation,
  listByRevision,
  decideFromPending,
  expirePendingByQuotation,
};
