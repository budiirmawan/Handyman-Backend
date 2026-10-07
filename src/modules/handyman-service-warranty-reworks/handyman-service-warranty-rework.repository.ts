import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { handymanServiceWarrantyReworkNotEligibleError }
  from './handyman-service-warranty-rework.errors';
import type {
  HandymanServiceWarrantyReworkEventRecord,
  HandymanServiceWarrantyReworkEventType,
  HandymanServiceWarrantyReworkRecord,
  HandymanServiceWarrantyReworkStatus,
  NewHandymanServiceWarrantyRework,
  NewHandymanServiceWarrantyReworkEvent,
} from './handyman-service-warranty-rework.types';

/**
 * CR-HM-15 PART 03 — free-warranty-rework repository. The ONLY writer of
 * `handyman_service_warranty_reworks` and
 * `handyman_service_warranty_rework_events`.
 *
 * Client, warranty, execution scope and BAST are read FROM the approved
 * claim row in the INSERT itself — a caller never supplies identity,
 * time or status. The record enters as REWORK_DRAFT; the DB guard
 * re-proves that, the APPROVED-claim gate, identity immutability, the
 * bounded ladder, the verification reuse of CR-HM-10 evidence/QC
 * (read-only) and the event-backed law.
 *
 * The warranty HEAD is never written here: the head belongs to the
 * warranty module's repository, which the rework service calls (one
 * writer code path for `handyman_service_warranties`).
 *
 * ZERO chargeable separation, ZERO pricing/payment/settlement, ZERO
 * FM/SaaS access, ZERO HTTP. The original BAST, the warranty start
 * boundary, the CR-HM-10 tables and the whole service history are never
 * written here.
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const REWORK_SELECT = `
  SELECT id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
         status, scope_note, proposed_by_user_id, proposed_at,
         authorized_at, authorized_by_user_id, started_at, completed_at,
         completion_note, verified_at, verified_by_user_id,
         verification_evidence_record_id, verification_qc_run_id,
         created_at, updated_at
    FROM handyman_service_warranty_reworks`;

const EVENT_SELECT = `
  SELECT id, client_id, rework_id, claim_id, warranty_id,
         execution_scope_id, bast_id, event_type, idempotency_key,
         actor_user_id, occurred_at, created_at
    FROM handyman_service_warranty_rework_events`;

function mapRework(row: Row): HandymanServiceWarrantyReworkRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    warrantyId: row.warranty_id,
    claimId: row.claim_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    status: row.status as HandymanServiceWarrantyReworkStatus,
    scopeNote: row.scope_note,
    proposedByUserId: row.proposed_by_user_id,
    proposedAt: row.proposed_at,
    authorizedAt: row.authorized_at ?? null,
    authorizedByUserId: row.authorized_by_user_id ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    completionNote: row.completion_note ?? null,
    verifiedAt: row.verified_at ?? null,
    verifiedByUserId: row.verified_by_user_id ?? null,
    verificationEvidenceRecordId: row.verification_evidence_record_id ?? null,
    verificationQcRunId: row.verification_qc_run_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: Row): HandymanServiceWarrantyReworkEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    reworkId: row.rework_id,
    claimId: row.claim_id,
    warrantyId: row.warranty_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    eventType: row.event_type as HandymanServiceWarrantyReworkEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

/**
 * Proposes the single free rework of an APPROVED claim. Identity anchors
 * come from `handyman_service_warranty_claims`; the claim guard and the
 * row guard both refuse a missing or non-APPROVED claim.
 */
async function createRework(
  executor: Executor = getPool(),
  record: NewHandymanServiceWarrantyRework,
): Promise<HandymanServiceWarrantyReworkRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_service_warranty_reworks (
       id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
       status, scope_note, proposed_by_user_id
     )
     SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
            c.bast_id, 'REWORK_DRAFT', $2, $3
       FROM handyman_service_warranty_claims c
      WHERE c.id = $4
     RETURNING id, client_id, warranty_id, claim_id, execution_scope_id,
               bast_id, status, scope_note, proposed_by_user_id,
               proposed_at, authorized_at, authorized_by_user_id,
               started_at, completed_at, completion_note, verified_at,
               verified_by_user_id, verification_evidence_record_id,
               verification_qc_run_id, created_at, updated_at`,
    [randomUUID(), record.scopeNote, record.proposedByUserId, record.claimId],
  );
  if (!result.rows[0]) {
    throw handymanServiceWarrantyReworkNotEligibleError(
      `rework-parent-claim-missing=${record.claimId}`,
    );
  }
  return mapRework(result.rows[0]);
}

async function findReworkById(
  executor: Executor = getPool(),
  reworkId: string,
  forUpdate = false,
): Promise<HandymanServiceWarrantyReworkRecord | null> {
  const result = await executor.query(
    `${REWORK_SELECT} WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [reworkId],
  );
  return result.rows[0] ? mapRework(result.rows[0]) : null;
}

async function findReworkByClaimId(
  executor: Executor = getPool(),
  claimId: string,
): Promise<HandymanServiceWarrantyReworkRecord | null> {
  const result = await executor.query(
    `${REWORK_SELECT} WHERE claim_id = $1`,
    [claimId],
  );
  return result.rows[0] ? mapRework(result.rows[0]) : null;
}

async function listReworksByWarrantyId(
  executor: Executor = getPool(),
  warrantyId: string,
): Promise<HandymanServiceWarrantyReworkRecord[]> {
  const result = await executor.query(
    `${REWORK_SELECT} WHERE warranty_id = $1
      ORDER BY created_at ASC, id ASC`,
    [warrantyId],
  );
  return result.rows.map(mapRework);
}

/**
 * Bounded lifecycle write: the status plus exactly the columns that
 * status owns. Identity columns are never part of this statement.
 */
async function updateReworkStatus(
  executor: Executor,
  reworkId: string,
  status: HandymanServiceWarrantyReworkStatus,
  actorUserId: string,
  options: {
    completionNote?: string | null;
    verificationEvidenceRecordId?: string | null;
    verificationQcRunId?: string | null;
  } = {},
): Promise<HandymanServiceWarrantyReworkRecord> {
  const result = await executor.query(
    `UPDATE handyman_service_warranty_reworks
        SET status = $2,
            authorized_at = CASE WHEN $2 = 'REWORK_AUTHORIZED'
                                 THEN COALESCE(authorized_at, NOW())
                                 ELSE authorized_at END,
            authorized_by_user_id = CASE
              WHEN $2 = 'REWORK_AUTHORIZED'
                THEN COALESCE(authorized_by_user_id, $3)
              ELSE authorized_by_user_id END,
            started_at = CASE WHEN $2 = 'REWORK_IN_PROGRESS'
                              THEN COALESCE(started_at, NOW())
                              ELSE started_at END,
            completed_at = CASE WHEN $2 = 'REWORK_COMPLETE'
                                THEN COALESCE(completed_at, NOW())
                                ELSE completed_at END,
            completion_note = CASE WHEN $4::text IS NOT NULL THEN $4
                                   ELSE completion_note END,
            verified_at = CASE WHEN $2 = 'REWORK_VERIFIED'
                               THEN COALESCE(verified_at, NOW())
                               ELSE verified_at END,
            verified_by_user_id = CASE WHEN $2 = 'REWORK_VERIFIED'
                                       THEN COALESCE(verified_by_user_id, $3)
                                       ELSE verified_by_user_id END,
            verification_evidence_record_id = CASE WHEN $2 = 'REWORK_VERIFIED'
              THEN $5 ELSE verification_evidence_record_id END,
            verification_qc_run_id = CASE WHEN $2 = 'REWORK_VERIFIED'
              THEN $6 ELSE verification_qc_run_id END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, warranty_id, claim_id, execution_scope_id,
                bast_id, status, scope_note, proposed_by_user_id,
                proposed_at, authorized_at, authorized_by_user_id,
                started_at, completed_at, completion_note, verified_at,
                verified_by_user_id, verification_evidence_record_id,
                verification_qc_run_id, created_at, updated_at`,
    [
      reworkId,
      status,
      actorUserId,
      options.completionNote ?? null,
      options.verificationEvidenceRecordId ?? null,
      options.verificationQcRunId ?? null,
    ],
  );
  return mapRework(result.rows[0]);
}

async function insertReworkEvent(
  executor: Executor = getPool(),
  record: NewHandymanServiceWarrantyReworkEvent,
): Promise<HandymanServiceWarrantyReworkEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_service_warranty_rework_events (
       id, client_id, rework_id, claim_id, warranty_id, execution_scope_id,
       bast_id, event_type, idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, client_id, rework_id, claim_id, warranty_id,
               execution_scope_id, bast_id, event_type, idempotency_key,
               actor_user_id, occurred_at, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.reworkId,
      record.claimId,
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

async function findReworkEventByIdempotency(
  executor: Executor = getPool(),
  reworkId: string,
  eventType: HandymanServiceWarrantyReworkEventType,
  idempotencyKey: string,
): Promise<HandymanServiceWarrantyReworkEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE rework_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [reworkId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

/**
 * Proposal replay lookup: the PROPOSE key is spent once per claim, so a
 * retried proposal converges on the SAME rework instead of minting a
 * second one.
 */
async function findReworkEventByClaimIdempotency(
  executor: Executor = getPool(),
  claimId: string,
  eventType: HandymanServiceWarrantyReworkEventType,
  idempotencyKey: string,
): Promise<HandymanServiceWarrantyReworkEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE claim_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [claimId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

/** READ-ONLY CR-HM-10 lookups (evidence + QC authority). */
async function findEvidenceScope(
  executor: Executor = getPool(),
  evidenceRecordId: string,
): Promise<{ clientId: string; executionScopeId: string } | null> {
  const result = await executor.query(
    `SELECT client_id, execution_scope_id
       FROM handyman_evidence_records
      WHERE id = $1`,
    [evidenceRecordId],
  );
  const row = result.rows[0];
  return row
    ? { clientId: row.client_id, executionScopeId: row.execution_scope_id }
    : null;
}

async function findQcRunScopeAndStatus(
  executor: Executor = getPool(),
  qcRunId: string,
): Promise<{
  clientId: string;
  executionScopeId: string;
  status: string;
} | null> {
  const result = await executor.query(
    `SELECT client_id, execution_scope_id, status
       FROM handyman_qc_runs
      WHERE id = $1`,
    [qcRunId],
  );
  const row = result.rows[0];
  return row
    ? {
      clientId: row.client_id,
      executionScopeId: row.execution_scope_id,
      status: row.status,
    }
    : null;
}

export const handymanServiceWarrantyReworkRepository = {
  createRework,
  findReworkById,
  findReworkByClaimId,
  listReworksByWarrantyId,
  updateReworkStatus,
  insertReworkEvent,
  findReworkEventByIdempotency,
  findReworkEventByClaimIdempotency,
  findEvidenceScope,
  findQcRunScopeAndStatus,
};
