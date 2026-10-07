import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import {
  handymanCommercialAgreementClientConflictError,
} from './handyman-commercial-agreement.errors';
import type {
  HandymanCommercialAgreementEventRecord,
  HandymanCommercialAgreementEventType,
  HandymanCommercialAgreementRecord,
  HandymanCommercialAgreementStatus,
  HandymanCommercialAgreementVersionRecord,
  NewHandymanCommercialAgreement,
  NewHandymanCommercialAgreementEvent,
  NewHandymanCommercialAgreementVersion,
} from './handyman-commercial-agreement.types';

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;
const PG_UNIQUE_VIOLATION = '23505';

const AGREEMENT_SELECT = `
  SELECT id, client_id, created_by_user_id, created_at, updated_at
    FROM handyman_commercial_agreements`;

const VERSION_SELECT = `
  SELECT v.id, v.agreement_id, a.client_id, v.version_number, v.status,
         v.effective_from, v.effective_to, v.created_by_user_id,
         v.created_at, v.updated_at
    FROM handyman_commercial_agreement_versions v
    JOIN handyman_commercial_agreements a ON a.id = v.agreement_id`;

const EVENT_SELECT = `
  SELECT id, client_id, agreement_id, version_id, event_type,
         idempotency_key, actor_user_id, occurred_at, created_at
    FROM handyman_commercial_agreement_events`;

function mapAgreement(row: Row): HandymanCommercialAgreementRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: Row): HandymanCommercialAgreementVersionRecord {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    clientId: row.client_id,
    versionNumber: Number(row.version_number),
    status: row.status as HandymanCommercialAgreementStatus,
    effectiveFrom: row.effective_from ?? null,
    effectiveTo: row.effective_to ?? null,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: Row): HandymanCommercialAgreementEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    agreementId: row.agreement_id,
    versionId: row.version_id,
    eventType: row.event_type as HandymanCommercialAgreementEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

async function findAgreementByClientId(
  executor: Executor,
  clientId: string,
  forUpdate = false,
): Promise<HandymanCommercialAgreementRecord | null> {
  const result = await executor.query(
    `${AGREEMENT_SELECT} WHERE client_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [clientId],
  );
  return result.rows[0] ? mapAgreement(result.rows[0]) : null;
}

async function findAgreementById(
  executor: Executor,
  agreementId: string,
): Promise<HandymanCommercialAgreementRecord | null> {
  const result = await executor.query(
    `${AGREEMENT_SELECT} WHERE id = $1`,
    [agreementId],
  );
  return result.rows[0] ? mapAgreement(result.rows[0]) : null;
}

async function createAgreement(
  executor: Executor,
  record: NewHandymanCommercialAgreement,
): Promise<HandymanCommercialAgreementRecord> {
  const id = randomUUID();
  try {
    const result = await executor.query(
      `INSERT INTO handyman_commercial_agreements (
         id, client_id, created_by_user_id
       ) VALUES ($1, $2, $3)
       RETURNING id, client_id, created_by_user_id, created_at, updated_at`,
      [id, record.clientId, record.createdByUserId],
    );
    return mapAgreement(result.rows[0]);
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === PG_UNIQUE_VIOLATION) {
      // ONE agreement per client (frozen §5): the client row is the
      // aggregate anchor — a second root is a bounded conflict.
      throw handymanCommercialAgreementClientConflictError(
        record.clientId,
      );
    }
    throw error;
  }
}

async function nextVersionNumber(
  executor: Executor,
  agreementId: string,
): Promise<number> {
  const result = await executor.query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
       FROM handyman_commercial_agreement_versions
      WHERE agreement_id = $1`,
    [agreementId],
  );
  return Number(result.rows[0].next);
}

async function insertVersion(
  executor: Executor,
  record: NewHandymanCommercialAgreementVersion,
): Promise<HandymanCommercialAgreementVersionRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `WITH inserted AS (
       INSERT INTO handyman_commercial_agreement_versions (
         id, agreement_id, version_number, created_by_user_id
       ) VALUES ($1, $2, $3, $4)
       RETURNING id, agreement_id, version_number, status,
                 effective_from, effective_to, created_by_user_id,
                 created_at, updated_at
     )
     SELECT i.id, i.agreement_id, a.client_id, i.version_number, i.status,
            i.effective_from, i.effective_to, i.created_by_user_id,
            i.created_at, i.updated_at
       FROM inserted i
       JOIN handyman_commercial_agreements a ON a.id = i.agreement_id`,
    [id, record.agreementId, record.versionNumber, record.createdByUserId],
  );
  return mapVersion(result.rows[0]);
}

async function findVersionById(
  executor: Executor,
  versionId: string,
): Promise<HandymanCommercialAgreementVersionRecord | null> {
  const result = await executor.query(
    `${VERSION_SELECT} WHERE v.id = $1`,
    [versionId],
  );
  return result.rows[0] ? mapVersion(result.rows[0]) : null;
}

async function findActiveVersion(
  executor: Executor,
  agreementId: string,
): Promise<HandymanCommercialAgreementVersionRecord | null> {
  const result = await executor.query(
    `${VERSION_SELECT} WHERE v.agreement_id = $1 AND v.status = 'ACTIVE'`,
    [agreementId],
  );
  return result.rows[0] ? mapVersion(result.rows[0]) : null;
}

async function updateVersionLifecycle(
  executor: Executor,
  versionId: string,
  lifecycle: {
    status: HandymanCommercialAgreementStatus;
    effectiveFrom?: Date | null;
    effectiveTo?: Date | null;
  },
): Promise<HandymanCommercialAgreementVersionRecord> {
  const result = await executor.query(
    `WITH updated AS (
       UPDATE handyman_commercial_agreement_versions
          SET status = $2,
              effective_from = COALESCE($3::timestamptz, effective_from),
              effective_to = $4::timestamptz,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, agreement_id, version_number, status,
                  effective_from, effective_to, created_by_user_id,
                  created_at, updated_at
     )
     SELECT u.id, u.agreement_id, a.client_id, u.version_number, u.status,
            u.effective_from, u.effective_to, u.created_by_user_id,
            u.created_at, u.updated_at
       FROM updated u
       JOIN handyman_commercial_agreements a ON a.id = u.agreement_id`,
    [
      versionId,
      lifecycle.status,
      lifecycle.effectiveFrom ?? null,
      lifecycle.effectiveTo ?? null,
    ],
  );
  return mapVersion(result.rows[0]);
}

async function insertEvent(
  executor: Executor,
  record: NewHandymanCommercialAgreementEvent,
): Promise<HandymanCommercialAgreementEventRecord> {
  const id = randomUUID();
  const result = await executor.query(
    `INSERT INTO handyman_commercial_agreement_events (
       id, client_id, agreement_id, version_id, event_type,
       idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, client_id, agreement_id, version_id, event_type,
               idempotency_key, actor_user_id, occurred_at, created_at`,
    [
      id,
      record.clientId,
      record.agreementId,
      record.versionId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapEvent(result.rows[0]);
}

async function findEventByIdempotency(
  executor: Executor,
  agreementId: string,
  eventType: HandymanCommercialAgreementEventType,
  idempotencyKey: string,
): Promise<HandymanCommercialAgreementEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE agreement_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [agreementId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

async function resolveEffectiveVersionAt(
  executor: Executor,
  clientId: string,
  asOf: Date,
): Promise<HandymanCommercialAgreementVersionRecord | null> {
  const result = await executor.query(
    `${VERSION_SELECT}
      WHERE a.client_id = $1
        AND v.status IN ('ACTIVE', 'SUPERSEDED')
        AND v.effective_from <= $2
        AND (v.effective_to IS NULL OR v.effective_to > $2)`,
    [clientId, asOf],
  );
  return result.rows[0] ? mapVersion(result.rows[0]) : null;
}

export const handymanCommercialAgreementRepository = {
  findAgreementByClientId,
  findAgreementById,
  createAgreement,
  nextVersionNumber,
  insertVersion,
  findVersionById,
  findActiveVersion,
  updateVersionLifecycle,
  insertEvent,
  findEventByIdempotency,
  resolveEffectiveVersionAt,
};
