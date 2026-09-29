import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { handymanWorkSessionActiveConflictError }
  from './handyman-work-session.errors';
import type {
  HandymanWorkSessionEventRecord,
  HandymanWorkSessionEventType,
  HandymanWorkSessionHelperPresenceRecord,
  HandymanWorkSessionRecord,
  HandymanWorkSessionStatus,
  NewHandymanWorkSession,
  NewHandymanWorkSessionEvent,
  NewHandymanWorkSessionHelperPresence,
} from './handyman-work-session.types';

/**
 * CR-HM-08 PART 01 — work-session repository. The ONLY writer of
 * `handyman_work_sessions`, `handyman_work_session_events`, and
 * `handyman_work_session_helper_presence`. ZERO transition/state-
 * machine decision logic, ZERO arrival-gate logic, ZERO helper-
 * derivation logic (server crew derivation arrives with PART 02+).
 * All timestamps are DB-server clock — callers pass no time.
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;
const PG_UNIQUE_VIOLATION = '23505';

const SESSION_SELECT = `
  SELECT id, client_id, execution_scope_id, assignment_id,
         lead_worker_id, lead_user_id, status, checked_in_at,
         started_work_at, completed_at, checked_out_at,
         created_at, updated_at
    FROM handyman_work_sessions`;

const EVENT_SELECT = `
  SELECT id, client_id, session_id, execution_scope_id, event_type,
         idempotency_key, occurred_at, actor_user_id, created_at
    FROM handyman_work_session_events`;

const PRESENCE_SELECT = `
  SELECT id, client_id, session_id, event_id, execution_scope_id,
         helper_worker_id, helper_user_id, created_at
    FROM handyman_work_session_helper_presence`;

function mapSession(row: Row): HandymanWorkSessionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    assignmentId: row.assignment_id,
    leadWorkerId: row.lead_worker_id,
    leadUserId: row.lead_user_id,
    status: row.status as HandymanWorkSessionStatus,
    checkedInAt: row.checked_in_at,
    startedWorkAt: row.started_work_at,
    completedAt: row.completed_at,
    checkedOutAt: row.checked_out_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: Row): HandymanWorkSessionEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    sessionId: row.session_id,
    executionScopeId: row.execution_scope_id,
    eventType: row.event_type as HandymanWorkSessionEventType,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

function mapPresence(row: Row): HandymanWorkSessionHelperPresenceRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    sessionId: row.session_id,
    eventId: row.event_id,
    executionScopeId: row.execution_scope_id,
    helperWorkerId: row.helper_worker_id,
    helperUserId: row.helper_user_id,
    createdAt: row.created_at,
  };
}

/**
 * Creates the session projection in CHECKED_IN with server-clock
 * checked_in_at (a session can only come to exist via check-in —
 * FROZEN §5; the eligibility GATE that proves the caller earns that
 * row arrives with PART 02 commands, NOT here). A second ACTIVE
 * session on the same scope violates the partial unique index and is
 * mapped to the bounded 409 active-conflict.
 */
async function createWorkSession(
  executor: Executor = getPool(),
  record: NewHandymanWorkSession,
): Promise<HandymanWorkSessionRecord> {
  try {
    const result = await executor.query(
      `INSERT INTO handyman_work_sessions (
         id, client_id, execution_scope_id, assignment_id,
         lead_worker_id, lead_user_id, status, checked_in_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'CHECKED_IN', NOW())
       RETURNING id, client_id, execution_scope_id, assignment_id,
                 lead_worker_id, lead_user_id, status, checked_in_at,
                 started_work_at, completed_at, checked_out_at,
                 created_at, updated_at`,
      [
        randomUUID(),
        record.clientId,
        record.executionScopeId,
        record.assignmentId,
        record.leadWorkerId,
        record.leadUserId,
      ],
    );
    return mapSession(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      throw handymanWorkSessionActiveConflictError(
        record.executionScopeId,
      );
    }
    throw error;
  }
}

async function findWorkSessionById(
  executor: Executor = getPool(),
  id: string,
): Promise<HandymanWorkSessionRecord | null> {
  const result = await executor.query(
    `${SESSION_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

/**
 * THE active (non-terminal) session for a scope, or null. At most
 * one can exist (partial unique index); CHECKED_OUT rows are
 * historical by definition.
 */
async function findActiveWorkSessionByExecutionScope(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanWorkSessionRecord | null> {
  const result = await executor.query(
    `${SESSION_SELECT}
      WHERE execution_scope_id = $1 AND status <> 'CHECKED_OUT'
      ORDER BY created_at DESC LIMIT 1`,
    [executionScopeId],
  );
  return result.rows[0] ? mapSession(result.rows[0]) : null;
}

/**
 * Appends a transition event with server-clock occurred_at. The
 * (session, event_type, idempotency_key) unique index backstops
 * replay; a duplicate insert raises 23505 — deciding replay-vs-
 * conflict is a LATER-PART concern; this layer only persists.
 */
async function appendWorkSessionEvent(
  executor: Executor = getPool(),
  record: NewHandymanWorkSessionEvent,
): Promise<HandymanWorkSessionEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_work_session_events (
       id, client_id, session_id, execution_scope_id, event_type,
       idempotency_key, occurred_at, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
     RETURNING id, client_id, session_id, execution_scope_id,
               event_type, idempotency_key, occurred_at,
               actor_user_id, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.sessionId,
      record.executionScopeId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapEvent(result.rows[0]);
}

async function findWorkSessionEventByIdempotency(
  executor: Executor = getPool(),
  sessionId: string,
  eventType: HandymanWorkSessionEventType,
  idempotencyKey: string,
): Promise<HandymanWorkSessionEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE session_id = $1 AND event_type = $2
        AND idempotency_key = $3`,
    [sessionId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

async function listWorkSessionEventsBySession(
  executor: Executor = getPool(),
  sessionId: string,
): Promise<HandymanWorkSessionEventRecord[]> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE session_id = $1 ORDER BY occurred_at, created_at, id`,
    [sessionId],
  );
  return result.rows.map(mapEvent);
}

/**
 * Appends one helper-presence snapshot row binding a helper worker
 * (and login identity when they have one) to a specific session
 * event (presence opens at CHECK_IN, closes at CHECK_OUT — FROZEN
 * §7). The helper DERIVATION itself (server reads current crew
 * membership) is a LATER-PART concern; this layer only persists
 * given server-side input. NO billable flag/rate/duration exists.
 */
async function insertWorkSessionHelperPresence(
  executor: Executor = getPool(),
  record: NewHandymanWorkSessionHelperPresence,
): Promise<HandymanWorkSessionHelperPresenceRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_work_session_helper_presence (
       id, client_id, session_id, event_id, execution_scope_id,
       helper_worker_id, helper_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, client_id, session_id, event_id,
               execution_scope_id, helper_worker_id, helper_user_id,
               created_at`,
    [
      randomUUID(),
      record.clientId,
      record.sessionId,
      record.eventId,
      record.executionScopeId,
      record.helperWorkerId,
      record.helperUserId ?? null,
    ],
  );
  return mapPresence(result.rows[0]);
}

async function listWorkSessionHelperPresenceBySession(
  executor: Executor = getPool(),
  sessionId: string,
): Promise<HandymanWorkSessionHelperPresenceRecord[]> {
  const result = await executor.query(
    `${PRESENCE_SELECT}
      WHERE session_id = $1 ORDER BY created_at, id`,
    [sessionId],
  );
  return result.rows.map(mapPresence);
}

export const handymanWorkSessionRepository = {
  createWorkSession,
  findWorkSessionById,
  findActiveWorkSessionByExecutionScope,
  appendWorkSessionEvent,
  findWorkSessionEventByIdempotency,
  listWorkSessionEventsBySession,
  insertWorkSessionHelperPresence,
  listWorkSessionHelperPresenceBySession,
};
