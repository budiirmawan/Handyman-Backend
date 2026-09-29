import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { handymanBastActiveConflictError } from './handyman-bast.errors';
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
  SELECT id, client_id, execution_scope_id, status,
         issued_at, accepted_at, rejected_at, voided_at,
         created_at, updated_at
    FROM handyman_bast_documents`;

const EVENT_SELECT = `
  SELECT id, client_id, bast_id, execution_scope_id, event_type,
         idempotency_key, actor_user_id, occurred_at, created_at
    FROM handyman_bast_events`;

function mapBast(row: Row): HandymanBastRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
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
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
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
         id, client_id, execution_scope_id, status
       ) VALUES ($1, $2, $3, 'DRAFT')
       RETURNING id, client_id, execution_scope_id, status,
                 issued_at, accepted_at, rejected_at, voided_at,
                 created_at, updated_at`,
      [id, record.clientId, record.executionScopeId],
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

async function findActiveBastByScopeId(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanBastRecord | null> {
  const result = await executor.query(
    `${BAST_SELECT}
      WHERE execution_scope_id = $1 AND status <> 'VOID'
      ORDER BY created_at DESC LIMIT 1`,
    [executionScopeId],
  );
  return result.rows[0] ? mapBast(result.rows[0]) : null;
}

async function updateBastStatus(
  executor: Executor = getPool(),
  id: string,
  status: HandymanBastStatus,
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
  const result = await executor.query(
    `UPDATE handyman_bast_documents
        SET status = $2,
            ${issuedAtSql},
            ${acceptedAtSql},
            ${rejectedAtSql},
            ${voidedAtSql},
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, execution_scope_id, status,
                issued_at, accepted_at, rejected_at, voided_at,
                created_at, updated_at`,
    [id, status],
  );
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
       idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, client_id, bast_id, execution_scope_id, event_type,
               idempotency_key, actor_user_id, occurred_at, created_at`,
    [
      id,
      record.clientId,
      record.bastId,
      record.executionScopeId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
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

export const handymanBastRepository = {
  createBast,
  findBastById,
  findActiveBastByScopeId,
  updateBastStatus,
  insertEvent,
  findEventByIdempotency,
  insertSignOff,
};
