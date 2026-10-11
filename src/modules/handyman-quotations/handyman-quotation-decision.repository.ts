import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationDecisionActorType,
  HandymanQuotationDecisionRecord,
  NewHandymanQuotationDecision,
} from './handyman-quotation-decision.types';

/**
 * CR-HM-06 PART 04 — decision repository (FROZEN F6/F7). Executor-
 * first; INSERT + bounded reads ONLY. No UPDATE/DELETE (0394 trigger).
 *
 * W03 PART 03E (A01 §10.3 C4): the select and insert column lists carry the
 * actor columns `0438`/`0442` added. Widening the lists is the whole change
 * this file needs — the row is still written once and never updated, and the
 * actor half is expressed through the discriminated `input.actor`, so there is
 * exactly one place where `decision_actor_type` and the id columns are made to
 * agree with each other. A `USER` arm still maps to a `USER` row (history reads
 * and the fingerprint of a legacy decision), and the ledger guard independently
 * refuses any NEW `USER` row; this file does not try to be the authority for
 * that rule, and it does not help a caller dodge it either.
 */

type Row = {
  id: string;
  client_id: string;
  quotation_id: string;
  quotation_version_id: string;
  decision: HandymanQuotationDecisionRecord['decision'];
  tenant_company_id: string;
  tenant_pic_id: string | null;
  decided_by_user_id: string | null;
  decision_actor_type: HandymanQuotationDecisionActorType;
  decided_by_tenant_pic_id: string | null;
  decided_by_pic_session_id: string | null;
  approval_binding_id: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  decided_at: Date;
  created_at: Date;
  updated_at: Date;
};

const DECISION_COLUMNS = `id, client_id, quotation_id, quotation_version_id,
         decision, tenant_company_id, tenant_pic_id, decided_by_user_id,
         decision_actor_type, decided_by_tenant_pic_id,
         decided_by_pic_session_id, approval_binding_id,
         idempotency_key, request_fingerprint, decided_at,
         created_at, updated_at`;

const DECISION_SELECT = `SELECT ${DECISION_COLUMNS}
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
    decisionActorType: row.decision_actor_type,
    decidedByTenantPicId: row.decided_by_tenant_pic_id,
    decidedByPicSessionId: row.decided_by_pic_session_id,
    approvalBindingId: row.approval_binding_id,
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
  const actor = input.actor;
  const result = await executor.query<Row>(
    `INSERT INTO handyman_quotation_decisions (
       id, client_id, quotation_id, quotation_version_id, decision,
       tenant_company_id, tenant_pic_id, decided_by_user_id,
       decision_actor_type, decided_by_tenant_pic_id,
       decided_by_pic_session_id, approval_binding_id,
       idempotency_key, request_fingerprint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${DECISION_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.quotationId,
      input.quotationVersionId,
      input.decision,
      input.tenantCompanyId,
      input.tenantPicId,
      actor.kind === 'USER' ? actor.userId : null,
      actor.kind,
      actor.kind === 'TENANT_PIC' ? actor.tenantPicId : null,
      actor.kind === 'TENANT_PIC' ? actor.picSessionId : null,
      actor.kind === 'TENANT_PIC' ? actor.approvalBindingId : null,
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
