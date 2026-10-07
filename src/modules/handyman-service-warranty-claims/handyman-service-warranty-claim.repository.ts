import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { handymanServiceWarrantyClaimNotEligibleError }
  from './handyman-service-warranty-claim.errors';
import type {
  HandymanServiceWarrantyClaimEventRecord,
  HandymanServiceWarrantyClaimEventType,
  HandymanServiceWarrantyClaimRecord,
  HandymanServiceWarrantyClaimStatus,
  NewHandymanServiceWarrantyClaim,
  NewHandymanServiceWarrantyClaimEvent,
} from './handyman-service-warranty-claim.types';

/**
 * CR-HM-15 PART 02 — service-warranty CLAIM repository. The ONLY writer
 * of `handyman_service_warranty_claims` and
 * `handyman_service_warranty_claim_events`.
 *
 * Client, execution scope and BAST are read FROM the parent warranty row
 * in the INSERT itself — a caller never supplies identity, time or
 * status. The claim is opened as CLAIM_DRAFT with no evidence of any
 * decision; the DB guard re-proves that, plus identity immutability,
 * evidence scope binding and the event-backed law.
 *
 * The warranty HEAD is never written here: the head belongs to the
 * warranty module's repository, which the claim service calls (one
 * writer code path for `handyman_service_warranties`).
 *
 * ZERO rework, ZERO pricing/payment/settlement, ZERO FM/SaaS access,
 * ZERO HTTP. The original BAST, session, QC and quotation history is
 * never touched.
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const CLAIM_SELECT = `
  SELECT id, client_id, warranty_id, execution_scope_id, bast_id,
         status, claim_note, evidence_record_id, opened_by_user_id,
         submitted_at, claimant_user_id, decided_at, decided_by_user_id,
         decision_note, withdrawn_at, created_at, updated_at
    FROM handyman_service_warranty_claims`;

const EVENT_SELECT = `
  SELECT id, client_id, claim_id, warranty_id, execution_scope_id,
         bast_id, event_type, idempotency_key, actor_user_id,
         occurred_at, created_at
    FROM handyman_service_warranty_claim_events`;

function mapClaim(row: Row): HandymanServiceWarrantyClaimRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    warrantyId: row.warranty_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    status: row.status as HandymanServiceWarrantyClaimStatus,
    claimNote: row.claim_note,
    evidenceRecordId: row.evidence_record_id ?? null,
    openedByUserId: row.opened_by_user_id,
    submittedAt: row.submitted_at ?? null,
    claimantUserId: row.claimant_user_id ?? null,
    decidedAt: row.decided_at ?? null,
    decidedByUserId: row.decided_by_user_id ?? null,
    decisionNote: row.decision_note ?? null,
    withdrawnAt: row.withdrawn_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: Row): HandymanServiceWarrantyClaimEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    claimId: row.claim_id,
    warrantyId: row.warranty_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    eventType: row.event_type as HandymanServiceWarrantyClaimEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

/**
 * Opens a CLAIM_DRAFT against the parent warranty. Identity anchors come
 * from `handyman_service_warranties`; the parent must exist (the FK and
 * the claim guard both refuse a missing or non-ACTIVE warranty).
 */
async function createClaim(
  executor: Executor = getPool(),
  record: NewHandymanServiceWarrantyClaim,
): Promise<HandymanServiceWarrantyClaimRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_service_warranty_claims (
       id, client_id, warranty_id, execution_scope_id, bast_id,
       status, claim_note, evidence_record_id, opened_by_user_id
     )
     SELECT $1, w.client_id, w.id, w.execution_scope_id, w.bast_id,
            'CLAIM_DRAFT', $2, $3, $4
       FROM handyman_service_warranties w
      WHERE w.id = $5
     RETURNING id, client_id, warranty_id, execution_scope_id, bast_id,
               status, claim_note, evidence_record_id, opened_by_user_id,
               submitted_at, claimant_user_id, decided_at,
               decided_by_user_id, decision_note, withdrawn_at,
               created_at, updated_at`,
    [
      randomUUID(),
      record.claimNote,
      record.evidenceRecordId,
      record.openedByUserId,
      record.warrantyId,
    ],
  );
  if (!result.rows[0]) {
    throw handymanServiceWarrantyClaimNotEligibleError(
      `claim-parent-warranty-missing=${record.warrantyId}`,
    );
  }
  return mapClaim(result.rows[0]);
}

async function findClaimById(
  executor: Executor = getPool(),
  claimId: string,
  forUpdate = false,
): Promise<HandymanServiceWarrantyClaimRecord | null> {
  const result = await executor.query(
    `${CLAIM_SELECT} WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [claimId],
  );
  return result.rows[0] ? mapClaim(result.rows[0]) : null;
}

async function findOpenClaimByWarrantyId(
  executor: Executor = getPool(),
  warrantyId: string,
): Promise<HandymanServiceWarrantyClaimRecord | null> {
  const result = await executor.query(
    `${CLAIM_SELECT}
      WHERE warranty_id = $1
        AND status IN ('CLAIM_DRAFT', 'CLAIM_SUBMITTED')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [warrantyId],
  );
  return result.rows[0] ? mapClaim(result.rows[0]) : null;
}

async function listClaimsByWarrantyId(
  executor: Executor = getPool(),
  warrantyId: string,
): Promise<HandymanServiceWarrantyClaimRecord[]> {
  const result = await executor.query(
    `${CLAIM_SELECT} WHERE warranty_id = $1
      ORDER BY created_at ASC, id ASC`,
    [warrantyId],
  );
  return result.rows.map(mapClaim);
}

/** Bounded lifecycle write: status + the columns that status owns. */
async function updateClaimStatus(
  executor: Executor,
  claimId: string,
  status: HandymanServiceWarrantyClaimStatus,
  evidenceRecordId: string | null,
  actorUserId: string,
  decisionNote: string | null,
): Promise<HandymanServiceWarrantyClaimRecord> {
  const result = await executor.query(
    `UPDATE handyman_service_warranty_claims
        SET status = $2,
            evidence_record_id = COALESCE($3, evidence_record_id),
            submitted_at = CASE WHEN $2 = 'CLAIM_SUBMITTED'
                                THEN COALESCE(submitted_at, NOW())
                                ELSE submitted_at END,
            claimant_user_id = CASE WHEN $2 = 'CLAIM_SUBMITTED'
                                    THEN COALESCE(claimant_user_id, $4)
                                    ELSE claimant_user_id END,
            decided_at = CASE WHEN $2 IN ('CLAIM_APPROVED', 'CLAIM_REJECTED')
                              THEN COALESCE(decided_at, NOW())
                              ELSE decided_at END,
            decided_by_user_id = CASE
              WHEN $2 IN ('CLAIM_APPROVED', 'CLAIM_REJECTED')
                THEN COALESCE(decided_by_user_id, $4)
              ELSE decided_by_user_id END,
            decision_note = CASE
              WHEN $2 IN ('CLAIM_APPROVED', 'CLAIM_REJECTED')
                THEN $5
              ELSE decision_note END,
            withdrawn_at = CASE WHEN $2 = 'CLAIM_WITHDRAWN'
                                THEN COALESCE(withdrawn_at, NOW())
                                ELSE withdrawn_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, warranty_id, execution_scope_id, bast_id,
                status, claim_note, evidence_record_id, opened_by_user_id,
                submitted_at, claimant_user_id, decided_at,
                decided_by_user_id, decision_note, withdrawn_at,
                created_at, updated_at`,
    [claimId, status, evidenceRecordId, actorUserId, decisionNote],
  );
  return mapClaim(result.rows[0]);
}

async function insertClaimEvent(
  executor: Executor = getPool(),
  record: NewHandymanServiceWarrantyClaimEvent,
): Promise<HandymanServiceWarrantyClaimEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_service_warranty_claim_events (
       id, client_id, claim_id, warranty_id, execution_scope_id, bast_id,
       event_type, idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, claim_id, warranty_id, execution_scope_id,
               bast_id, event_type, idempotency_key, actor_user_id,
               occurred_at, created_at`,
    [
      randomUUID(),
      record.clientId,
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

async function findClaimEventByIdempotency(
  executor: Executor = getPool(),
  claimId: string,
  eventType: HandymanServiceWarrantyClaimEventType,
  idempotencyKey: string,
): Promise<HandymanServiceWarrantyClaimEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE claim_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [claimId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

/**
 * Intake replay lookup: the OPEN key is spent once per warranty, so a
 * retried intake converges on the SAME claim instead of minting a second
 * one.
 */
async function findClaimEventByWarrantyIdempotency(
  executor: Executor = getPool(),
  warrantyId: string,
  eventType: HandymanServiceWarrantyClaimEventType,
  idempotencyKey: string,
): Promise<HandymanServiceWarrantyClaimEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE warranty_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [warrantyId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

/** Evidence binding check: same client and ORIGINAL execution scope. */
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

export const handymanServiceWarrantyClaimRepository = {
  createClaim,
  findClaimById,
  findOpenClaimByWarrantyId,
  listClaimsByWarrantyId,
  updateClaimStatus,
  insertClaimEvent,
  findClaimEventByIdempotency,
  findClaimEventByWarrantyIdempotency,
  findEvidenceScope,
};
