import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationRecord,
  HandymanQuotationStatus,
} from './handyman-quotation.types';

/**
 * CR-HM-BE-03 RUN 2 — Quotation envelope persistence.
 *
 * The envelope is the single commercial identity for a request's quotation
 * loop; every state move here is a guarded UPDATE (status precondition in
 * the WHERE clause) so concurrent commands cannot both win. `sent_revision_id`
 * is bound only by the guarded send.
 */

const QUOTATION_SELECT = `
  id,
  request_id AS "requestId",
  client_id AS "clientId",
  building_id AS "buildingId",
  quotation_number AS "quotationNumber",
  currency,
  status,
  tenant_company_id AS "tenantCompanyId",
  tenant_pic_id AS "tenantPicId",
  customer_name AS "customerName",
  customer_phone AS "customerPhone",
  customer_email AS "customerEmail",
  sent_revision_id AS "sentRevisionId",
  sent_at AS "sentAt",
  withdrawn_at AS "withdrawnAt",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: {
    requestId: string;
    clientId: string;
    buildingId: string;
    quotationNumber: string;
    currency: string;
    tenantCompanyId: string | null;
    tenantPicId: string | null;
    customerName: string;
    customerPhone: string | null;
    customerEmail: string | null;
    idempotencyKey: string | null;
    idempotencyFingerprint: string | null;
    createdByUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationRecord> {
  const result = await executor.query<HandymanQuotationRecord>(
    `INSERT INTO handyman_quotations
       (id, request_id, client_id, building_id, quotation_number, currency,
        tenant_company_id, tenant_pic_id, customer_name, customer_phone,
        customer_email, idempotency_key, idempotency_fingerprint,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${QUOTATION_SELECT}`,
    [
      randomUUID(),
      input.requestId,
      input.clientId,
      input.buildingId,
      input.quotationNumber,
      input.currency,
      input.tenantCompanyId,
      input.tenantPicId,
      input.customerName,
      input.customerPhone,
      input.customerEmail,
      input.idempotencyKey,
      input.idempotencyFingerprint,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<HandymanQuotationRecord>(
    `SELECT ${QUOTATION_SELECT} FROM handyman_quotations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Row lock for governed number/revision sequencing inside a transaction. */
async function lockById(
  id: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<HandymanQuotationRecord>(
    `SELECT ${QUOTATION_SELECT} FROM handyman_quotations
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<HandymanQuotationRecord>(
    `SELECT ${QUOTATION_SELECT} FROM handyman_quotations
     WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function listByRequest(
  requestId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationRecord[]> {
  const result = await executor.query<HandymanQuotationRecord>(
    `SELECT ${QUOTATION_SELECT} FROM handyman_quotations
     WHERE request_id = $1
     ORDER BY created_at DESC, id DESC`,
    [requestId],
  );
  return result.rows;
}

/**
 * Last generated number for the client, under the numbering advisory lock
 * (CR-HM-BE-01 request-numbering idiom). The caller must hold
 * `pg_advisory_xact_lock('handyman_quotations', clientId)` first.
 */
async function findLastQuotationNumber(
  clientId: string,
  prefix: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<string | null> {
  const result = await executor.query<{ quotationNumber: string }>(
    `SELECT quotation_number AS "quotationNumber"
     FROM handyman_quotations
     WHERE client_id = $1 AND quotation_number LIKE $2
     ORDER BY quotation_number DESC
     LIMIT 1
     FOR UPDATE`,
    [clientId, `${prefix}%`],
  );
  return result.rows[0]?.quotationNumber ?? null;
}

/** Guarded envelope → SENT with the exact-revision binding. */
async function markSentFrom(
  id: string,
  sentRevisionId: string,
  expectedStatuses: readonly HandymanQuotationStatus[],
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<HandymanQuotationRecord>(
    `UPDATE handyman_quotations
     SET status = 'SENT',
         sent_revision_id = $2,
         sent_at = NOW(),
         withdrawn_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status = ANY($3::text[])
     RETURNING ${QUOTATION_SELECT}`,
    [id, sentRevisionId, [...expectedStatuses]],
  );
  return result.rows[0] ?? null;
}

/** Guarded SENT → WITHDRAWN; the sent facts are retained as history. */
async function markWithdrawnFromSent(
  id: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<HandymanQuotationRecord>(
    `UPDATE handyman_quotations
     SET status = 'WITHDRAWN',
         withdrawn_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = 'SENT'
     RETURNING ${QUOTATION_SELECT}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Guarded SENT → APPROVED/REJECTED (CR-HM-BE-03 RUN 3 customer decision).
 * The sent binding facts are retained — the migration-0352 decided-state
 * CHECK requires them as history.
 */
async function markDecidedFromSent(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<HandymanQuotationRecord>(
    `UPDATE handyman_quotations
     SET status = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'SENT'
     RETURNING ${QUOTATION_SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

export const handymanQuotationRepository = {
  create,
  findById,
  lockById,
  findByIdempotencyKey,
  listByRequest,
  findLastQuotationNumber,
  markSentFrom,
  markWithdrawnFromSent,
  markDecidedFromSent,
};
