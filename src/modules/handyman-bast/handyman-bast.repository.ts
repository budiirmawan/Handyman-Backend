import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import {
  handymanBastActiveConflictError,
  handymanBastIllegalTransitionError,
} from './handyman-bast.errors';
import type {
  HandymanBastEventRecord,
  HandymanBastEventType,
  HandymanBastRecord,
  HandymanBastSignOffRecord,
  HandymanBastStatus,
  NewHandymanBast,
  NewHandymanBastEvent,
  NewHandymanBastSignOff,
} from './handyman-bast.types';

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;
const PG_UNIQUE_VIOLATION = '23505';

const BAST_SELECT = `
  SELECT id, client_id, execution_scope_id, qc_run_id, status,
         issued_at, accepted_at, rejected_at, voided_at,
         created_at, updated_at
    FROM handyman_bast_documents`;

const EVENT_SELECT = `
  SELECT id, client_id, bast_id, execution_scope_id, event_type,
         idempotency_key, actor_user_id, actor_care_actor_id, commercial_consent_id, occurred_at, created_at, metadata
    FROM handyman_bast_events`;

function mapBast(row: Row): HandymanBastRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    qcRunId: row.qc_run_id ?? null,
    status: row.status as HandymanBastStatus,
    issuedAt: row.issued_at,
    acceptedAt: row.accepted_at ?? null,
    rejectedAt: row.rejected_at ?? null,
    voidedAt: row.voided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: Row): HandymanBastEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    bastId: row.bast_id,
    executionScopeId: row.execution_scope_id,
    eventType: row.event_type as HandymanBastEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    ...(row.actor_care_actor_id ? { actorCareActorId: row.actor_care_actor_id, commercialConsentId: row.commercial_consent_id } : {}),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
  };
}

async function createBast(
  executor: Executor = getPool(),
  record: NewHandymanBast,
): Promise<HandymanBastRecord> {
  const id = randomUUID();
  try {
    const result = await executor.query(
      `INSERT INTO handyman_bast_documents (
         id, client_id, execution_scope_id, qc_run_id, status
       ) VALUES ($1, $2, $3, $4, 'DRAFT')
       RETURNING id, client_id, execution_scope_id, qc_run_id, status,
                 issued_at, accepted_at, rejected_at, voided_at,
                 created_at, updated_at`,
      [id, record.clientId, record.executionScopeId, record.qcRunId],
    );
    return mapBast(result.rows[0]);
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw handymanBastActiveConflictError(record.executionScopeId);
    }
    throw error;
  }
}

async function findBastById(
  executor: Executor = getPool(),
  id: string,
): Promise<HandymanBastRecord | null> {
  const result = await executor.query(
    `${BAST_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapBast(result.rows[0]) : null;
}

/**
 * Transactional command read. Serializes concurrent duplicate ISSUE/VOID and
 * customer sign-off requests before replay lookup, so a same-key retry waits
 * for the winner and then returns its original append-only event instead of
 * spuriously receiving ILLEGAL_TRANSITION.
 */
async function findBastByIdForUpdate(
  executor: Executor,
  id: string,
): Promise<HandymanBastRecord | null> {
  const result = await executor.query(
    `${BAST_SELECT} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapBast(result.rows[0]) : null;
}

async function findActiveBastByScopeId(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanBastRecord | null> {
  const result = await executor.query(
    `${BAST_SELECT}
      WHERE execution_scope_id = $1 AND status NOT IN ('VOID', 'REJECTED')
      ORDER BY created_at DESC LIMIT 1`,
    [executionScopeId],
  );
  return result.rows[0] ? mapBast(result.rows[0]) : null;
}

async function findLatestBastByScopeId(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanBastRecord | null> {
  const result = await executor.query(
    `${BAST_SELECT}
      WHERE execution_scope_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [executionScopeId],
  );
  return result.rows[0] ? mapBast(result.rows[0]) : null;
}

async function updateBastStatus(
  executor: Executor = getPool(),
  id: string,
  status: HandymanBastStatus,
  expectedFromStatus: HandymanBastStatus,
): Promise<HandymanBastRecord> {
  const issuedAtSql = status === 'ISSUED'
    ? 'issued_at = COALESCE(issued_at, NOW())'
    : 'issued_at = issued_at';
  const acceptedAtSql = status === 'ACCEPTED'
    ? 'accepted_at = COALESCE(accepted_at, NOW())'
    : 'accepted_at = accepted_at';
  const rejectedAtSql = status === 'REJECTED'
    ? 'rejected_at = COALESCE(rejected_at, NOW())'
    : 'rejected_at = rejected_at';
  const voidedAtSql = status === 'VOID'
    ? 'voided_at = NOW()'
    : 'voided_at = voided_at';
  // CR-HM-BAST-HTTP-01 — the frozen state machine is enforced ATOMICALLY:
  // the UPDATE only applies from the exact status the transition was
  // validated against (same optimistic-concurrency precedent as the QC/defect
  // expectedVersion guards). A racing writer that already transitioned the
  // document matches zero rows and receives the standard 409
  // HANDYMAN_BAST_ILLEGAL_TRANSITION instead of appending a duplicate event;
  // the serial path is byte-for-byte unchanged.
  const result = await executor.query(
    `UPDATE handyman_bast_documents
        SET status = $2,
            ${issuedAtSql},
            ${acceptedAtSql},
            ${rejectedAtSql},
            ${voidedAtSql},
            updated_at = NOW()
      WHERE id = $1 AND status = $3
      RETURNING id, client_id, execution_scope_id, qc_run_id, status,
                issued_at, accepted_at, rejected_at, voided_at,
                created_at, updated_at`,
    [id, status, expectedFromStatus],
  );
  if (!result.rows[0]) {
    // Lost the concurrency race: another writer already transitioned this
    // document away from `expectedFromStatus`.
    const action = ({
      ISSUED: 'ISSUE',
      VOID: 'VOID',
      ACCEPTED: 'ACCEPT',
      REJECTED: 'REJECT',
    } as Record<string, string>)[status] ?? status;
    throw handymanBastIllegalTransitionError(expectedFromStatus, action);
  }
  return mapBast(result.rows[0]);
}

async function insertEvent(
  executor: Executor = getPool(),
  record: NewHandymanBastEvent,
): Promise<HandymanBastEventRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `INSERT INTO handyman_bast_events (
       id, client_id, bast_id, execution_scope_id, event_type,
       idempotency_key, actor_user_id, metadata, actor_care_actor_id, commercial_consent_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     RETURNING id, client_id, bast_id, execution_scope_id, event_type,
               idempotency_key, actor_user_id, actor_care_actor_id, commercial_consent_id, occurred_at, created_at, metadata`,
    [
      id,
      record.clientId,
      record.bastId,
      record.executionScopeId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
      JSON.stringify(record.metadata ?? {}),
      record.actorCareActorId ?? null,
      record.commercialConsentId ?? null,
    ],
  );
  return mapEvent(result.rows[0]);
}

async function findEventByIdempotency(
  executor: Executor = getPool(),
  bastId: string,
  eventType: HandymanBastEventType,
  idempotencyKey: string,
): Promise<HandymanBastEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE bast_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [bastId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

async function listEventsByBastId(
  executor: Executor = getPool(),
  bastId: string,
): Promise<HandymanBastEventRecord[]> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE bast_id = $1
      ORDER BY occurred_at ASC, created_at ASC, id ASC`,
    [bastId],
  );
  return result.rows.map(mapEvent);
}

const SIGN_OFF_SELECT = `
  SELECT id, client_id, bast_id, event_id, execution_scope_id,
         decision, signature_digest, evidence_record_id,
         reject_reason, created_at
    FROM handyman_bast_sign_offs`;

function mapSignOff(row: Row): HandymanBastSignOffRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    bastId: row.bast_id,
    eventId: row.event_id,
    executionScopeId: row.execution_scope_id,
    decision: row.decision,
    signatureDigest: row.signature_digest,
    evidenceRecordId: row.evidence_record_id,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
  };
}

async function insertSignOff(
  executor: Executor = getPool(),
  record: NewHandymanBastSignOff,
): Promise<HandymanBastSignOffRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `INSERT INTO handyman_bast_sign_offs (
       id, client_id, bast_id, event_id, execution_scope_id,
       decision, signature_digest, evidence_record_id, reject_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, bast_id, event_id, execution_scope_id,
               decision, signature_digest, evidence_record_id,
               reject_reason, created_at`,
    [
      id,
      record.clientId,
      record.bastId,
      record.eventId,
      record.executionScopeId,
      record.decision,
      record.signatureDigest,
      record.evidenceRecordId,
      record.rejectReason,
    ],
  );
  return mapSignOff(result.rows[0]);
}

async function findSignOffByEventId(
  executor: Executor = getPool(),
  eventId: string,
): Promise<HandymanBastSignOffRecord | null> {
  const result = await executor.query(
    `${SIGN_OFF_SELECT} WHERE event_id = $1`,
    [eventId],
  );
  return result.rows[0] ? mapSignOff(result.rows[0]) : null;
}

async function listSignOffsByBastId(
  executor: Executor = getPool(),
  bastId: string,
): Promise<HandymanBastSignOffRecord[]> {
  const result = await executor.query(
    `${SIGN_OFF_SELECT}
      WHERE bast_id = $1
      ORDER BY created_at ASC, id ASC`,
    [bastId],
  );
  return result.rows.map(mapSignOff);
}

export const handymanBastRepository = {
  createBast,
  findBastById,
  findBastByIdForUpdate,
  findActiveBastByScopeId,
  findLatestBastByScopeId,
  updateBastStatus,
  insertEvent,
  findEventByIdempotency,
  listEventsByBastId,
  insertSignOff,
  findSignOffByEventId,
  listSignOffsByBastId,
};
