import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { SecureLinkRecord } from './secure-link.types';

/**
 * BE-26J — Notification secure link repository.
 *
 * Stores only the token hash (never the raw token). Mutations are limited to
 * the lifecycle transitions:
 *   - markUsed     — consume a use (ACTIVE → USED when exhausted),
 *   - markRevoked  — revoke (ACTIVE → REVOKED),
 *   - markExpired  — expire (ACTIVE → EXPIRED),
 * all guarded by `WHERE status = 'ACTIVE'` for idempotency/race safety.
 */

const SELECT_COLUMNS = `id,
  token_hash AS "tokenHash",
  client_id AS "clientId",
  recipient_user_id AS "recipientUserId",
  target_entity_type AS "targetEntityType",
  target_entity_id AS "targetEntityId",
  action,
  expires_at AS "expiresAt",
  max_uses AS "maxUses",
  used_count AS "usedCount",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export type NewSecureLink = {
  tokenHash: string;
  clientId: string;
  recipientUserId: string;
  targetEntityType: string;
  targetEntityId: string;
  action: string;
  expiresAt: Date;
  maxUses: number;
};

async function create(input: NewSecureLink): Promise<SecureLinkRecord> {
  const result = await getPool().query<SecureLinkRecord>(
    `INSERT INTO notification_secure_links (
       id, token_hash, client_id, recipient_user_id, target_entity_type,
       target_entity_id, action, expires_at, max_uses, used_count, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'ACTIVE')
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.tokenHash,
      input.clientId,
      input.recipientUserId,
      input.targetEntityType,
      input.targetEntityId,
      input.action,
      input.expiresAt,
      input.maxUses,
    ],
  );
  return result.rows[0];
}

async function findByTokenHash(
  tokenHash: string,
): Promise<SecureLinkRecord | null> {
  const result = await getPool().query<SecureLinkRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_secure_links
      WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

async function findById(id: string): Promise<SecureLinkRecord | null> {
  const result = await getPool().query<SecureLinkRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM notification_secure_links
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Consumes one use; flips to USED when exhausted. ACTIVE-only. */
async function markUsed(id: string): Promise<SecureLinkRecord | null> {
  const result = await getPool().query<SecureLinkRecord>(
    `UPDATE notification_secure_links
        SET used_count = used_count + 1,
            status = CASE WHEN used_count + 1 >= max_uses THEN 'USED' ELSE 'ACTIVE' END,
            updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Revokes an ACTIVE link (ACTIVE → REVOKED). */
async function markRevoked(id: string): Promise<SecureLinkRecord | null> {
  const result = await getPool().query<SecureLinkRecord>(
    `UPDATE notification_secure_links
        SET status = 'REVOKED', updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Expires an ACTIVE link (ACTIVE → EXPIRED). */
async function markExpired(id: string): Promise<SecureLinkRecord | null> {
  const result = await getPool().query<SecureLinkRecord>(
    `UPDATE notification_secure_links
        SET status = 'EXPIRED', updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const secureLinkRepository = {
  create,
  findById,
  findByTokenHash,
  markExpired,
  markRevoked,
  markUsed,
};
