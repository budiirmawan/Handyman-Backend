import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanWorkSessionRecord,
  HandymanWorkSessionStatus,
} from './handyman-work-session.types';

/**
 * CR-HM-BE-06 RUN 2 — work session persistence.
 *
 * Append-only history: the ONLY mutation surface is the guarded OPEN →
 * CLOSED closure UPDATE (structure-enforced by the 0357 integrity trigger).
 * `started_at`/`ended_at` are never supplied by callers — the database
 * clock stamps them (server-authoritative time). Idempotency follows the
 * CR-HM-BE-01/Run-1 convention: client-scoped key + business-fact
 * fingerprint, insert-or-read under `ON CONFLICT DO NOTHING`, and the
 * one-OPEN-per-visit partial unique index as the structural backstop.
 *
 * The single vendor_work lock helper below is a LOCK + status read of the
 * BE-15B-owned row for the decisive start operation (§9) — it duplicates no
 * vendor-work lifecycle rule; every transition stays in the owning service.
 */

type Executor = Pick<PoolClient, 'query'>;

const SESSION_SELECT = `
  id,
  client_id                   AS "clientId",
  visit_id                    AS "visitId",
  vendor_work_id              AS "vendorWorkId",
  handyman_job_assignment_id  AS "handymanJobAssignmentId",
  status,
  started_at                  AS "startedAt",
  started_by_user_id          AS "startedByUserId",
  ended_at                    AS "endedAt",
  ended_by_user_id            AS "endedByUserId",
  occurred_at                 AS "occurredAt",
  idempotency_key             AS "idempotencyKey",
  idempotency_fingerprint     AS "idempotencyFingerprint",
  created_at                  AS "createdAt",
  updated_at                  AS "updatedAt"
`;

/** One OPEN session row to insert (the service owns every fact). */
export type NewHandymanWorkSession = {
  clientId: string;
  visitId: string;
  vendorWorkId: string;
  handymanJobAssignmentId: string;
  startedByUserId: string;
  occurredAt: Date | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
};

/**
 * Insert-or-read under the client-scoped idempotency unique constraint (the
 * CR-HM-BE-01 repository convention): `created: false` means a concurrent
 * duplicate won and its row is returned for fingerprint comparison — the
 * caller decides replay-convergence vs idempotency conflict.
 */
async function create(
  input: NewHandymanWorkSession,
  executor: Executor,
): Promise<{ record: HandymanWorkSessionRecord; created: boolean }> {
  const result = await executor.query<HandymanWorkSessionRecord>(
    `INSERT INTO handyman_work_sessions
       (id, client_id, visit_id, vendor_work_id, handyman_job_assignment_id,
        status, started_by_user_id, occurred_at, idempotency_key,
        idempotency_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, $9)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING ${SESSION_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.visitId,
      input.vendorWorkId,
      input.handymanJobAssignmentId,
      input.startedByUserId,
      input.occurredAt,
      input.idempotencyKey,
      input.idempotencyFingerprint,
    ],
  );
  if (result.rows[0]) {
    return { record: result.rows[0], created: true };
  }
  const existing = await findByIdempotencyKey(
    input.clientId,
    input.idempotencyKey,
    executor,
  );
  if (!existing) {
    // Unreachable under the visit-row lock + unique constraint; never guess.
    throw new Error(
      'Work session idempotency conflict resolved to no row; retry the command.',
    );
  }
  return { record: existing, created: false };
}

async function findById(
  id: string,
  executor: Executor = getPool(),
): Promise<HandymanWorkSessionRecord | null> {
  const result = await executor.query<HandymanWorkSessionRecord>(
    `SELECT ${SESSION_SELECT} FROM handyman_work_sessions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Executor = getPool(),
): Promise<HandymanWorkSessionRecord | null> {
  const result = await executor.query<HandymanWorkSessionRecord>(
    `SELECT ${SESSION_SELECT} FROM handyman_work_sessions
     WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

/** The visit's ONE OPEN session (partial unique index guarantees ≤ 1). */
async function findOpenByVisitId(
  visitId: string,
  executor: Executor = getPool(),
): Promise<HandymanWorkSessionRecord | null> {
  const result = await executor.query<HandymanWorkSessionRecord>(
    `SELECT ${SESSION_SELECT} FROM handyman_work_sessions
     WHERE visit_id = $1 AND status = 'OPEN'`,
    [visitId],
  );
  return result.rows[0] ?? null;
}

/** Full session history of one visit, oldest first (Run-3 read model). */
async function listByVisitId(
  visitId: string,
  executor: Executor = getPool(),
): Promise<HandymanWorkSessionRecord[]> {
  const result = await executor.query<HandymanWorkSessionRecord>(
    `SELECT ${SESSION_SELECT} FROM handyman_work_sessions
     WHERE visit_id = $1
     ORDER BY started_at ASC, id ASC`,
    [visitId],
  );
  return result.rows;
}

/** Row lock for the decisive end operation (replay-safe closure). */
async function lockById(
  id: string,
  executor: Executor,
): Promise<HandymanWorkSessionRecord | null> {
  const result = await executor.query<HandymanWorkSessionRecord>(
    `SELECT ${SESSION_SELECT} FROM handyman_work_sessions
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Guarded closure: OPEN → CLOSED with server-stamped ended_at and the real
 * closing actor. Returns NULL when the row was not OPEN (a concurrent close
 * won — the caller converges onto the recorded closure, never re-closes).
 */
async function closeSession(
  id: string,
  endedByUserId: string,
  executor: Executor,
): Promise<HandymanWorkSessionRecord | null> {
  const result = await executor.query<HandymanWorkSessionRecord>(
    `UPDATE handyman_work_sessions
     SET status = 'CLOSED',
         ended_at = NOW(),
         ended_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'OPEN'
     RETURNING ${SESSION_SELECT}`,
    [id, endedByUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * Locks the BE-15B-owned vendor work row and reads its status for the
 * decisive execution-start state assertion (§3.J / §7). Lock + status read
 * only — no lifecycle rule is duplicated here.
 */
async function lockVendorWorkForExecutionStart(
  vendorWorkId: string,
  executor: Executor,
): Promise<{ id: string; status: string } | null> {
  const result = await executor.query<{ id: string; status: string }>(
    `SELECT id, status FROM vendor_works WHERE id = $1 FOR UPDATE`,
    [vendorWorkId],
  );
  return result.rows[0] ?? null;
}

export const handymanWorkSessionRepository = {
  create,
  findById,
  findByIdempotencyKey,
  findOpenByVisitId,
  listByVisitId,
  lockById,
  closeSession,
  lockVendorWorkForExecutionStart,
};
