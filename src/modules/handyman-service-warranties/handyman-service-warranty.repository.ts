import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { handymanServiceWarrantyNotEligibleError }
  from './handyman-service-warranty.errors';
import type {
  HandymanServiceWarrantyCoverageRecord,
  HandymanServiceWarrantyCoverageType,
  HandymanServiceWarrantyEventRecord,
  HandymanServiceWarrantyEventType,
  HandymanServiceWarrantyRecord,
  HandymanServiceWarrantyStatus,
  NewHandymanServiceWarranty,
  NewHandymanServiceWarrantyCoverage,
  NewHandymanServiceWarrantyEvent,
} from './handyman-service-warranty.types';

/**
 * CR-HM-15 PART 01 — service-warranty repository. The ONLY writer of
 * `handyman_service_warranties`, `handyman_service_warranty_coverages`,
 * and `handyman_service_warranty_events`.
 *
 * This layer persists SERVER-derived facts only: the ACCEPTED BAST
 * anchor, its acceptance instant and the derived start boundary arrive
 * from the command layer (and are re-verified by the DB anchor trigger).
 * ZERO claim/rework, ZERO payment/ledger/pricing, ZERO FM/SaaS access,
 * ZERO HTTP. The original BAST and service history are read-only here —
 * nothing in this module ever writes a BAST, session, QC, evidence or
 * quotation row.
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const WARRANTY_SELECT = `
  SELECT id, client_id, execution_scope_id, bast_id, bast_accepted_at,
         status, starts_at, expired_at, started_by_user_id,
         created_at, updated_at
    FROM handyman_service_warranties`;

const COVERAGE_SELECT = `
  SELECT id, client_id, warranty_id, execution_scope_id, coverage_type,
         created_at
    FROM handyman_service_warranty_coverages`;

const EVENT_SELECT = `
  SELECT id, client_id, warranty_id, execution_scope_id, bast_id,
         event_type, idempotency_key, actor_user_id, occurred_at,
         created_at
    FROM handyman_service_warranty_events`;

function mapWarranty(row: Row): HandymanServiceWarrantyRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    bastAcceptedAt: row.bast_accepted_at,
    status: row.status as HandymanServiceWarrantyStatus,
    startsAt: row.starts_at,
    expiredAt: row.expired_at ?? null,
    startedByUserId: row.started_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCoverage(row: Row): HandymanServiceWarrantyCoverageRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    warrantyId: row.warranty_id,
    executionScopeId: row.execution_scope_id,
    coverageType: row.coverage_type as HandymanServiceWarrantyCoverageType,
    createdAt: row.created_at,
  };
}

function mapEvent(row: Row): HandymanServiceWarrantyEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    warrantyId: row.warranty_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    eventType: row.event_type as HandymanServiceWarrantyEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

/**
 * Creates the single warranty head for an execution scope. Client,
 * execution scope, acceptance instant and start boundary are read FROM
 * the BAST row in the same statement — no caller-supplied time,
 * identity or status is involved. The DB anchor trigger independently
 * refuses a BAST that is not ACCEPTED.
 */
async function createWarrantyFromAcceptedBast(
  executor: Executor = getPool(),
  record: NewHandymanServiceWarranty,
): Promise<HandymanServiceWarrantyRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_service_warranties (
       id, client_id, execution_scope_id, bast_id, bast_accepted_at,
       status, starts_at, started_by_user_id
     )
     SELECT $1, b.client_id, b.execution_scope_id, b.id, b.accepted_at,
            'ACTIVE', b.accepted_at, $2
       FROM handyman_bast_documents b
      WHERE b.id = $3
     RETURNING id, client_id, execution_scope_id, bast_id,
               bast_accepted_at, status, starts_at, expired_at,
               started_by_user_id, created_at, updated_at`,
    [randomUUID(), record.startedByUserId, record.bastId],
  );
  if (!result.rows[0]) {
    throw handymanServiceWarrantyNotEligibleError(
      `bast-not-found=${record.bastId}`,
    );
  }
  return mapWarranty(result.rows[0]);
}

async function findWarrantyById(
  executor: Executor = getPool(),
  warrantyId: string,
  forUpdate = false,
): Promise<HandymanServiceWarrantyRecord | null> {
  const result = await executor.query(
    `${WARRANTY_SELECT} WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [warrantyId],
  );
  return result.rows[0] ? mapWarranty(result.rows[0]) : null;
}

async function findWarrantyByExecutionScopeId(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanServiceWarrantyRecord | null> {
  const result = await executor.query(
    `${WARRANTY_SELECT} WHERE execution_scope_id = $1`,
    [executionScopeId],
  );
  return result.rows[0] ? mapWarranty(result.rows[0]) : null;
}

/** Applies the guarded status transition (PART 01: ACTIVE → EXPIRED). */
async function updateWarrantyStatus(
  executor: Executor,
  warrantyId: string,
  status: HandymanServiceWarrantyStatus,
): Promise<HandymanServiceWarrantyRecord> {
  const result = await executor.query(
    `UPDATE handyman_service_warranties
        SET status = $2,
            expired_at = CASE WHEN $2 = 'EXPIRED'
                              THEN COALESCE(expired_at, NOW())
                              ELSE expired_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, execution_scope_id, bast_id,
                bast_accepted_at, status, starts_at, expired_at,
                started_by_user_id, created_at, updated_at`,
    [warrantyId, status],
  );
  return mapWarranty(result.rows[0]);
}

/** Inserts one immutable coverage row (WORKMANSHIP or MATERIAL). */
async function insertCoverage(
  executor: Executor,
  record: NewHandymanServiceWarrantyCoverage,
): Promise<HandymanServiceWarrantyCoverageRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_service_warranty_coverages (
       id, client_id, warranty_id, execution_scope_id, coverage_type
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, client_id, warranty_id, execution_scope_id,
               coverage_type, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.warrantyId,
      record.executionScopeId,
      record.coverageType,
    ],
  );
  return mapCoverage(result.rows[0]);
}

async function listCoverages(
  executor: Executor = getPool(),
  warrantyId: string,
): Promise<HandymanServiceWarrantyCoverageRecord[]> {
  const result = await executor.query(
    `${COVERAGE_SELECT} WHERE warranty_id = $1
      ORDER BY coverage_type ASC, created_at ASC`,
    [warrantyId],
  );
  return result.rows.map(mapCoverage);
}

async function insertEvent(
  executor: Executor = getPool(),
  record: NewHandymanServiceWarrantyEvent,
): Promise<HandymanServiceWarrantyEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_service_warranty_events (
       id, client_id, warranty_id, execution_scope_id, bast_id,
       event_type, idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, warranty_id, execution_scope_id, bast_id,
               event_type, idempotency_key, actor_user_id, occurred_at,
               created_at`,
    [
      randomUUID(),
      record.clientId,
      record.warrantyId,
      record.executionScopeId,
      record.bastId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapEvent(result.rows[0]);
}

async function findEventByIdempotency(
  executor: Executor = getPool(),
  warrantyId: string,
  eventType: HandymanServiceWarrantyEventType,
  idempotencyKey: string,
): Promise<HandymanServiceWarrantyEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE warranty_id = $1 AND event_type = $2
        AND idempotency_key = $3`,
    [warrantyId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

export const handymanServiceWarrantyRepository = {
  createWarrantyFromAcceptedBast,
  findWarrantyById,
  findWarrantyByExecutionScopeId,
  updateWarrantyStatus,
  insertCoverage,
  listCoverages,
  insertEvent,
  findEventByIdempotency,
};
