import type { PoolClient } from 'pg';
import type { QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanArrivalChallengeRecord,
  HandymanArrivalChallengeStatus,
  NewHandymanArrivalChallenge,
} from './handyman-arrival-challenge.types';

/**
 * CR-HM-07 PART 01 — arrival challenge repository. The ONLY writer
 * of `handyman_arrival_challenges`: PENDING insert + the two
 * lifecycle projections (PENDING -> CONSUMED / PENDING -> EXPIRED)
 * permitted by the 0397 trigger. Raw tokens never appear here —
 * token_hash material only.
 */

type Row = QueryResultRow;

const CHALLENGE_SELECT = `
  SELECT id, client_id, execution_scope_id, assignment_id,
         actor_user_id, token_hash, status, expires_at, consumed_at,
         created_at, updated_at
    FROM handyman_arrival_challenges`;

function map(row: Row): HandymanArrivalChallengeRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    assignmentId: row.assignment_id,
    actorUserId: row.actor_user_id,
    tokenHash: row.token_hash,
    status: row.status as HandymanArrivalChallengeStatus,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * PENDING insert. expires_at is synthesized by the DATABASE SERVER
 * clock (`NOW() + INTERVAL '120 seconds'`) — the caller path passes
 * no time whatsoever. The partial one-PENDING unique index backstops
 * concurrency; the service maps 23505 to the bounded live-conflict.
 */
async function insertChallenge(
  executor: Pick<PoolClient, 'query'>,
  record: NewHandymanArrivalChallenge,
  ttlSeconds: number,
): Promise<HandymanArrivalChallengeRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_arrival_challenges (
       id, client_id, execution_scope_id, assignment_id,
       actor_user_id, token_hash, status, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING',
               NOW() + make_interval(secs => $7))
     RETURNING id, client_id, execution_scope_id, assignment_id,
               actor_user_id, token_hash, status, expires_at,
               consumed_at, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.executionScopeId,
      record.assignmentId,
      record.actorUserId,
      record.tokenHash,
      ttlSeconds,
    ],
  );
  return map(result.rows[0]);
}

/** Locked read of the exact challenge row (consume boundary). */
async function lockChallengeById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanArrivalChallengeRecord | null> {
  const result = await executor.query(
    `${CHALLENGE_SELECT}
      WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Live PENDING row for the (scope, actor) pair, if any. */
async function findPendingByScopeActor(
  executor: Pick<PoolClient, 'query'>,
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanArrivalChallengeRecord | null> {
  const result = await executor.query(
    `${CHALLENGE_SELECT}
      WHERE execution_scope_id = $1 AND actor_user_id = $2
        AND status = 'PENDING'`,
    [executionScopeId, actorUserId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Live PENDING row for the pair, locked (pre-insert conflict check). */
async function lockPendingByScopeActor(
  executor: Pick<PoolClient, 'query'>,
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanArrivalChallengeRecord | null> {
  const result = await executor.query(
    `${CHALLENGE_SELECT}
      WHERE execution_scope_id = $1 AND actor_user_id = $2
        AND status = 'PENDING' FOR UPDATE`,
    [executionScopeId, actorUserId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/**
 * Server-clock expiry projection for one pair: every PENDING row whose
 * TTL has passed moves to EXPIRED (the ONLY write this projection
 * performs; permitted by the 0397 trigger). Returns projected rows
 * (for audit journaling).
 */
async function expireStaleForScopeActor(
  executor: Pick<PoolClient, 'query'>,
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanArrivalChallengeRecord[]> {
  const result = await executor.query(
    `UPDATE handyman_arrival_challenges
        SET status = 'EXPIRED', updated_at = NOW()
      WHERE execution_scope_id = $1 AND actor_user_id = $2
        AND status = 'PENDING' AND expires_at <= NOW()
     RETURNING id, client_id, execution_scope_id, assignment_id,
               actor_user_id, token_hash, status, expires_at,
               consumed_at, created_at, updated_at`,
    [executionScopeId, actorUserId],
  );
  return result.rows.map(map);
}

/**
 * Atomic single-use consumption: PENDING -> CONSUMED with a
 * server-clock `consumed_at`, guarded by status in the WHERE clause
 * so a lost race can never double-consume. Returns the row, or null
 * when the guard failed (must already have been verified before).
 */
async function consumeIfPending(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanArrivalChallengeRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_arrival_challenges
        SET status = 'CONSUMED', consumed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING' AND expires_at > NOW()
     RETURNING id, client_id, execution_scope_id, assignment_id,
               actor_user_id, token_hash, status, expires_at,
               consumed_at, created_at, updated_at`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/**
 * Conditional DB-clock expiry projection for one exact row: moves
 * PENDING -> EXPIRED ONLY when the row is already overdue. Returns
 * the projected row, or null when still live (or not PENDING).
 */
async function expireIfPendingOverdue(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanArrivalChallengeRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_arrival_challenges
        SET status = 'EXPIRED', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING' AND expires_at <= NOW()
     RETURNING id, client_id, execution_scope_id, assignment_id,
               actor_user_id, token_hash, status, expires_at,
               consumed_at, created_at, updated_at`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Plain read (assignment snapshot reference / tests). */
async function findChallengeById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanArrivalChallengeRecord | null> {
  const result = await executor.query(
    `${CHALLENGE_SELECT}
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/**
 * Replay-token binding lookup (PART 04B): the challenge bound to one
 * (scope, actor, tokenHash) — any lifecycle status. READ ONLY; token
 * material never leaves the hash comparison boundary.
 */
async function findByScopeActorTokenHash(
  executor: Pick<PoolClient, 'query'> = getPool(),
  executionScopeId: string,
  actorUserId: string,
  tokenHash: string,
): Promise<HandymanArrivalChallengeRecord | null> {
  const result = await executor.query(
    `${CHALLENGE_SELECT}
      WHERE execution_scope_id = $1 AND actor_user_id = $2
        AND token_hash = $3`,
    [executionScopeId, actorUserId, tokenHash],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

export const handymanArrivalChallengeRepository = {
  insertChallenge,
  lockChallengeById,
  findPendingByScopeActor,
  lockPendingByScopeActor,
  expireStaleForScopeActor,
  consumeIfPending,
  expireIfPendingOverdue,
  findChallengeById,
  findByScopeActorTokenHash,
};
