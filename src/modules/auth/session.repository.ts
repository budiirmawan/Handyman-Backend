import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { CreateSessionInput, SessionRecord, SessionStatus } from './session.types';

type SessionRow = {
  id: string;
  userId: string;
  tokenHash: string;
  status: SessionStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

const SESSION_SELECT = `
  id,
  user_id AS "userId",
  token_hash AS "tokenHash",
  status,
  expires_at AS "expiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  revoked_at AS "revokedAt",
  last_used_at AS "lastUsedAt"
`;

function mapSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

async function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  const result = await getPool().query<SessionRow>(
    `INSERT INTO user_sessions (id, user_id, token_hash, expires_at, last_used_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING ${SESSION_SELECT}`,
    [randomUUID(), input.userId, input.tokenHash, input.expiresAt],
  );

  return mapSessionRow(result.rows[0]);
}

async function findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
  const result = await getPool().query<SessionRow>(
    `SELECT ${SESSION_SELECT} FROM user_sessions WHERE token_hash = $1`,
    [tokenHash],
  );

  const row = result.rows[0];
  return row ? mapSessionRow(row) : null;
}

/**
 * Revokes every ACTIVE session for a user (used when an account is
 * deactivated or suspended).
 */
async function revokeActiveByUserId(
  userId: string,
  revokedAt: Date,
): Promise<number> {
  const result = await getPool().query(
    `UPDATE user_sessions
     SET status = 'REVOKED', revoked_at = $2, updated_at = NOW()
     WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId, revokedAt],
  );

  return result.rowCount ?? 0;
}

async function revokeById(id: string, revokedAt: Date): Promise<SessionRecord | null> {
  const result = await getPool().query<SessionRow>(
    `UPDATE user_sessions
     SET status = 'REVOKED', revoked_at = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SESSION_SELECT}`,
    [id, revokedAt],
  );

  const row = result.rows[0];
  return row ? mapSessionRow(row) : null;
}

/**
 * Conservatively touches last_used_at only when the stored value is stale by
 * more than the configured interval, avoiding a write on every request.
 */
async function markUsedIfStale(id: string, lastUsedAt: Date, intervalMs: number): Promise<void> {
  await getPool().query(
    `UPDATE user_sessions
     SET last_used_at = $2, updated_at = NOW()
     WHERE id = $1
       AND (last_used_at IS NULL OR last_used_at < $3)`,
    [id, lastUsedAt, new Date(Date.now() - intervalMs)],
  );
}

export const sessionRepository = {
  createSession,
  findByTokenHash,
  markUsedIfStale,
  revokeActiveByUserId,
  revokeById,
};
