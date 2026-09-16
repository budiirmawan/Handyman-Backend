import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { HandymanQuotationApprovalLinkRecord } from './handyman-quotation-approval.types';

/**
 * CR-HM-BE-03 RUN 3 — Secure-link READINESS persistence.
 *
 * Hash-only token storage (SHA-256 hex; the raw token is returned once at
 * issuance and never persisted), required expiry, fixed single use, and the
 * ACTIVE/USED/REVOKED/EXPIRED lifecycle with guarded atomic transitions.
 * One ACTIVE link per approval is structurally enforced (partial unique
 * index). The consumption primitive below is INTERNAL readiness only: no
 * CR-HM-BE-03 Run-3 decision runtime and no public route consumes it —
 * public resolve/decide endpoints are an explicit security follow-up CR.
 */

const LINK_SELECT = `
  id,
  approval_id AS "approvalId",
  quotation_id AS "quotationId",
  client_id AS "clientId",
  building_id AS "buildingId",
  token_hash AS "tokenHash",
  recipient_name AS "recipientName",
  recipient_phone AS "recipientPhone",
  recipient_email AS "recipientEmail",
  status,
  max_uses AS "maxUses",
  uses_count AS "usesCount",
  expires_at AS "expiresAt",
  issued_by_user_id AS "issuedByUserId",
  issued_at AS "issuedAt",
  used_at AS "usedAt",
  revoked_at AS "revokedAt",
  revoked_by_user_id AS "revokedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: {
    approvalId: string;
    quotationId: string;
    clientId: string;
    buildingId: string;
    tokenHash: string;
    recipientName: string;
    recipientPhone: string | null;
    recipientEmail: string | null;
    expiresAt: Date;
    issuedByUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalLinkRecord> {
  const result = await executor.query<HandymanQuotationApprovalLinkRecord>(
    `INSERT INTO handyman_quotation_approval_links
       (id, approval_id, quotation_id, client_id, building_id, token_hash,
        recipient_name, recipient_phone, recipient_email, max_uses,
        expires_at, issued_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11)
     RETURNING ${LINK_SELECT}`,
    [
      randomUUID(),
      input.approvalId,
      input.quotationId,
      input.clientId,
      input.buildingId,
      input.tokenHash,
      input.recipientName,
      input.recipientPhone,
      input.recipientEmail,
      input.expiresAt,
      input.issuedByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalLinkRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalLinkRecord>(
    `SELECT ${LINK_SELECT} FROM handyman_quotation_approval_links WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function lockById(
  id: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationApprovalLinkRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalLinkRecord>(
    `SELECT ${LINK_SELECT} FROM handyman_quotation_approval_links
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByApproval(
  approvalId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalLinkRecord[]> {
  const result = await executor.query<HandymanQuotationApprovalLinkRecord>(
    `SELECT ${LINK_SELECT} FROM handyman_quotation_approval_links
     WHERE approval_id = $1
     ORDER BY issued_at DESC, id DESC`,
    [approvalId],
  );
  return result.rows;
}

async function listByQuotation(
  quotationId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalLinkRecord[]> {
  const result = await executor.query<HandymanQuotationApprovalLinkRecord>(
    `SELECT ${LINK_SELECT} FROM handyman_quotation_approval_links
     WHERE quotation_id = $1
     ORDER BY issued_at DESC, id DESC`,
    [quotationId],
  );
  return result.rows;
}

/** Guarded ACTIVE → REVOKED (revoke/consume races have one winner). */
async function revokeFromActive(
  id: string,
  actorUserId: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationApprovalLinkRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalLinkRecord>(
    `UPDATE handyman_quotation_approval_links
     SET status = 'REVOKED',
         revoked_at = NOW(),
         revoked_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${LINK_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * INTERNAL readiness primitive — atomic single-use consumption by token
 * hash. One guarded statement decides the race between consume/revoke/
 * expiry; a lapsed ACTIVE link is marked EXPIRED instead of consumed.
 * NOT exported through the module index and never wired to any decision or
 * public route in Run 3.
 */
async function consumeByTokenHash(
  tokenHash: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalLinkRecord | null> {
  await executor.query(
    `UPDATE handyman_quotation_approval_links
     SET status = 'EXPIRED', updated_at = NOW()
     WHERE status = 'ACTIVE' AND expires_at <= NOW()`,
  );
  const result = await executor.query<HandymanQuotationApprovalLinkRecord>(
    `UPDATE handyman_quotation_approval_links
     SET status = 'USED',
         uses_count = uses_count + 1,
         used_at = NOW(),
         updated_at = NOW()
     WHERE token_hash = $1 AND status = 'ACTIVE'
       AND expires_at > NOW() AND uses_count < max_uses
     RETURNING ${LINK_SELECT}`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** INTERNAL readiness lookup by hash — never returns the raw token (which
 * does not exist server-side) and is not exposed through the module index. */
async function findByTokenHash(
  tokenHash: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationApprovalLinkRecord | null> {
  const result = await executor.query<HandymanQuotationApprovalLinkRecord>(
    `SELECT ${LINK_SELECT} FROM handyman_quotation_approval_links
     WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

export const handymanQuotationApprovalLinkRepository = {
  create,
  findById,
  lockById,
  listByApproval,
  listByQuotation,
  revokeFromActive,
  consumeByTokenHash,
  findByTokenHash,
};
