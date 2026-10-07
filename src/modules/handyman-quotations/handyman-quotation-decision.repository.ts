import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationDecisionRecord,
  NewHandymanQuotationDecision,
} from './handyman-quotation-decision.types';

/**
 * CR-HM-06 PART 04 — decision repository (FROZEN F6/F7). Executor-
 * first; INSERT + bounded reads ONLY. No UPDATE/DELETE (0394 trigger).
 */

type Row = {
  id: string;
  client_id: string;
  quotation_id: string;
  quotation_version_id: string;
  decision: HandymanQuotationDecisionRecord['decision'];
  tenant_company_id: string;
  tenant_pic_id: string | null;
  decided_by_user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  decided_at: Date;
  created_at: Date;
  updated_at: Date;
};

const DECISION_SELECT = `
  SELECT id, client_id, quotation_id, quotation_version_id, decision,
         tenant_company_id, tenant_pic_id, decided_by_user_id,
         idempotency_key, request_fingerprint, decided_at,
         created_at, updated_at
    FROM handyman_quotation_decisions`;

function map(row: Row): HandymanQuotationDecisionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    quotationId: row.quotation_id,
    quotationVersionId: row.quotation_version_id,
    decision: row.decision,
    tenantCompanyId: row.tenant_company_id,
    tenantPicId: row.tenant_pic_id,
    decidedByUserId: row.decided_by_user_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertDecision(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanQuotationDecision,
): Promise<HandymanQuotationDecisionRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_quotation_decisions (
       id, client_id, quotation_id, quotation_version_id, decision,
       tenant_company_id, tenant_pic_id, decided_by_user_id,
       idempotency_key, request_fingerprint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, client_id, quotation_id, quotation_version_id,
               decision, tenant_company_id, tenant_pic_id,
               decided_by_user_id, idempotency_key, request_fingerprint,
               decided_at, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.quotationId,
      input.quotationVersionId,
      input.decision,
      input.tenantCompanyId,
      input.tenantPicId,
      input.decidedByUserId,
      input.idempotencyKey,
      input.requestFingerprint,
    ],
  );
  return map(result.rows[0]);
}

/** The single authoritative decision for a version, if any (locked). */
async function lockDecisionByVersion(
  executor: Pick<PoolClient, 'query'>,
  quotationVersionId: string,
): Promise<HandymanQuotationDecisionRecord | null> {
  const result = await executor.query<Row>(
    `${DECISION_SELECT} WHERE quotation_version_id = $1 FOR UPDATE`,
    [quotationVersionId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function findDecisionByVersion(
  executor: Pick<PoolClient, 'query'> = getPool(),
  quotationVersionId: string,
): Promise<HandymanQuotationDecisionRecord | null> {
  const result = await executor.query<Row>(
    `${DECISION_SELECT} WHERE quotation_version_id = $1`,
    [quotationVersionId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanQuotationDecisionRepository = {
  insertDecision,
  lockDecisionByVersion,
  findDecisionByVersion,
};
