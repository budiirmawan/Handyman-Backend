import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { HandymanServiceWarrantyReworkStatus }
  from '../handyman-service-warranty-reworks';
import {
  handymanChargeableAdditionalWorkIllegalTransitionError,
  handymanChargeableAdditionalWorkNotEligibleError,
} from './handyman-chargeable-additional-work.errors';
import type {
  HandymanChargeableAdditionalWorkEventRecord,
  HandymanChargeableAdditionalWorkEventType,
  HandymanChargeableAdditionalWorkRecord,
  HandymanChargeableAdditionalWorkStatus,
  HandymanChargeablePaymentTriggerFact,
  NewHandymanChargeableAdditionalWork,
  NewHandymanChargeableAdditionalWorkEvent,
} from './handyman-chargeable-additional-work.types';

/**
 * CR-HM-15 PART 04 — SOLE writer of the separated chargeable
 * additional-work family. It never writes the free rework table, the
 * claim table, the warranty head or CR-HM-10 evidence/QC: the free rework
 * status is read READ-ONLY for the separation law (B8).
 */

type Executor = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const WORK_COLUMNS = `
  id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
  status, scope_note, proposed_by_user_id, proposed_at, decided_at,
  decided_by_user_id, payment_trigger_emitted_at, created_at, updated_at`;

const EVENT_COLUMNS = `
  id, client_id, work_id, claim_id, warranty_id, execution_scope_id,
  bast_id, event_type, idempotency_key, actor_user_id, occurred_at,
  created_at`;

type WorkRow = {
  id: string;
  client_id: string;
  warranty_id: string;
  claim_id: string;
  execution_scope_id: string;
  bast_id: string;
  status: string;
  scope_note: string;
  proposed_by_user_id: string;
  proposed_at: Date;
  decided_at: Date | null;
  decided_by_user_id: string | null;
  payment_trigger_emitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type EventRow = {
  id: string;
  client_id: string;
  work_id: string;
  claim_id: string;
  warranty_id: string;
  execution_scope_id: string;
  bast_id: string;
  event_type: string;
  idempotency_key: string;
  actor_user_id: string;
  occurred_at: Date;
  created_at: Date;
};

function mapWork(row: WorkRow): HandymanChargeableAdditionalWorkRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    warrantyId: row.warranty_id,
    claimId: row.claim_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    status: row.status as HandymanChargeableAdditionalWorkStatus,
    scopeNote: row.scope_note,
    proposedByUserId: row.proposed_by_user_id,
    proposedAt: row.proposed_at,
    decidedAt: row.decided_at,
    decidedByUserId: row.decided_by_user_id,
    paymentTriggerEmittedAt: row.payment_trigger_emitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(
  row: EventRow,
): HandymanChargeableAdditionalWorkEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    workId: row.work_id,
    claimId: row.claim_id,
    warrantyId: row.warranty_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    eventType: row.event_type as HandymanChargeableAdditionalWorkEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

/**
 * Creates the SINGLE separated chargeable referral of a claim as
 * CHARGEABLE_PROPOSED. Client, warranty, execution scope and BAST are
 * read FROM the claim row — never supplied by the caller.
 */
async function createWork(
  executor: Executor = getPool(),
  record: NewHandymanChargeableAdditionalWork,
): Promise<HandymanChargeableAdditionalWorkRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_chargeable_additional_works (
       id, client_id, warranty_id, claim_id, execution_scope_id, bast_id,
       status, scope_note, proposed_by_user_id
     )
     SELECT $1, c.client_id, c.warranty_id, c.id, c.execution_scope_id,
            c.bast_id, 'CHARGEABLE_PROPOSED', $2, $3
       FROM handyman_service_warranty_claims c
      WHERE c.id = $4
     RETURNING ${WORK_COLUMNS}`,
    [randomUUID(), record.scopeNote, record.proposedByUserId, record.claimId],
  );
  const row = result.rows[0] as WorkRow | undefined;
  if (!row) {
    throw handymanChargeableAdditionalWorkNotEligibleError(
      `work-parent-claim-missing=${record.claimId}`,
    );
  }
  return mapWork(row);
}

async function findWorkById(
  executor: Executor = getPool(),
  workId: string,
  forUpdate = false,
): Promise<HandymanChargeableAdditionalWorkRecord | null> {
  const result = await executor.query(
    `SELECT ${WORK_COLUMNS} FROM handyman_chargeable_additional_works
      WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [workId],
  );
  const row = result.rows[0] as WorkRow | undefined;
  return row ? mapWork(row) : null;
}

/**
 * The separation law needs the claim's free rework state READ-ONLY; the
 * free rework family is never written from here (B8).
 */
async function findFreeReworkStatusForClaim(
  executor: Executor = getPool(),
  claimId: string,
): Promise<HandymanServiceWarrantyReworkStatus | null> {
  const result = await executor.query(
    `SELECT status FROM handyman_service_warranty_reworks
      WHERE claim_id = $1`,
    [claimId],
  );
  const row = result.rows[0] as { status: string } | undefined;
  return row ? (row.status as HandymanServiceWarrantyReworkStatus) : null;
}

async function findWorkByClaimId(
  executor: Executor = getPool(),
  claimId: string,
): Promise<HandymanChargeableAdditionalWorkRecord | null> {
  const result = await executor.query(
    `SELECT ${WORK_COLUMNS} FROM handyman_chargeable_additional_works
      WHERE claim_id = $1`,
    [claimId],
  );
  const row = result.rows[0] as WorkRow | undefined;
  return row ? mapWork(row) : null;
}

async function listWorksByWarrantyId(
  executor: Executor = getPool(),
  warrantyId: string,
): Promise<HandymanChargeableAdditionalWorkRecord[]> {
  const result = await executor.query(
    `SELECT ${WORK_COLUMNS} FROM handyman_chargeable_additional_works
      WHERE warranty_id = $1
      ORDER BY created_at ASC, id ASC`,
    [warrantyId],
  );
  return (result.rows as WorkRow[]).map(mapWork);
}

/**
 * Applies ONE customer decision. Acceptance also stamps the CR-HM-13
 * payment trigger fact; rejection leaves it NULL forever. No money is
 * ever written to this row.
 */
async function updateWorkDecision(
  executor: Executor,
  workId: string,
  status: HandymanChargeableAdditionalWorkStatus,
  actorUserId: string,
): Promise<HandymanChargeableAdditionalWorkRecord> {
  const result = await executor.query(
    `UPDATE handyman_chargeable_additional_works
        SET status = $2,
            decided_at = COALESCE(decided_at, NOW()),
            decided_by_user_id = COALESCE(decided_by_user_id, $3),
            payment_trigger_emitted_at = CASE
              WHEN $2 = 'CHARGEABLE_AUTHORIZED'
                THEN COALESCE(payment_trigger_emitted_at, NOW())
              ELSE payment_trigger_emitted_at END,
            updated_at = NOW()
      WHERE id = $1 AND status = 'CHARGEABLE_PROPOSED'
      RETURNING ${WORK_COLUMNS}`,
    [workId, status, actorUserId],
  );
  const row = result.rows[0] as WorkRow | undefined;
  if (!row) {
    // The guarded UPDATE only ever moves a PROPOSED referral.
    throw handymanChargeableAdditionalWorkIllegalTransitionError(
      'CHARGEABLE_DECIDED',
      `DECIDE:${workId}`,
    );
  }
  return mapWork(row);
}

async function insertWorkEvent(
  executor: Executor = getPool(),
  record: NewHandymanChargeableAdditionalWorkEvent,
): Promise<HandymanChargeableAdditionalWorkEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_chargeable_additional_work_events (
       id, client_id, work_id, claim_id, warranty_id, execution_scope_id,
       bast_id, event_type, idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${EVENT_COLUMNS}`,
    [
      randomUUID(),
      record.clientId,
      record.workId,
      record.claimId,
      record.warrantyId,
      record.executionScopeId,
      record.bastId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapEvent(result.rows[0] as EventRow);
}

async function findWorkEventByIdempotency(
  executor: Executor = getPool(),
  workId: string,
  eventType: HandymanChargeableAdditionalWorkEventType,
  idempotencyKey: string,
): Promise<HandymanChargeableAdditionalWorkEventRecord | null> {
  const result = await executor.query(
    `SELECT ${EVENT_COLUMNS} FROM handyman_chargeable_additional_work_events
      WHERE work_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [workId, eventType, idempotencyKey],
  );
  const row = result.rows[0] as EventRow | undefined;
  return row ? mapEvent(row) : null;
}

/**
 * Proposal replay lookup: the PROPOSE key is spent once per claim, so a
 * retried proposal converges on the SAME referral instead of minting a
 * second one.
 */
async function findWorkEventByClaimIdempotency(
  executor: Executor = getPool(),
  claimId: string,
  eventType: HandymanChargeableAdditionalWorkEventType,
  idempotencyKey: string,
): Promise<HandymanChargeableAdditionalWorkEventRecord | null> {
  const result = await executor.query(
    `SELECT ${EVENT_COLUMNS} FROM handyman_chargeable_additional_work_events
      WHERE claim_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [claimId, eventType, idempotencyKey],
  );
  const row = result.rows[0] as EventRow | undefined;
  return row ? mapEvent(row) : null;
}

/** The PAYMENT_TRIGGER event row of a referral, if it was authorized. */
async function findPaymentTriggerEventForWork(
  executor: Executor = getPool(),
  workId: string,
): Promise<HandymanChargeableAdditionalWorkEventRecord | null> {
  return findWorkEventByType(executor, workId, 'PAYMENT_TRIGGER');
}

async function findWorkEventByType(
  executor: Executor = getPool(),
  workId: string,
  eventType: HandymanChargeableAdditionalWorkEventType,
): Promise<HandymanChargeableAdditionalWorkEventRecord | null> {
  const result = await executor.query(
    `SELECT ${EVENT_COLUMNS} FROM handyman_chargeable_additional_work_events
      WHERE work_id = $1 AND event_type = $2
      ORDER BY occurred_at ASC, id ASC
      LIMIT 1`,
    [workId, eventType],
  );
  const row = result.rows[0] as EventRow | undefined;
  return row ? mapEvent(row) : null;
}

/**
 * The outbound CR-HM-13 seam: the emitted payment trigger fact of an
 * authorized chargeable scope. It carries no amount — CR-HM-13 owns
 * pricing, ledger, payment and settlement.
 */
async function findPaymentTriggerForWork(
  executor: Executor = getPool(),
  workId: string,
): Promise<HandymanChargeablePaymentTriggerFact | null> {
  const result = await executor.query(
    `SELECT e.id, e.work_id, e.client_id, e.claim_id, e.warranty_id,
            e.execution_scope_id, e.bast_id, e.occurred_at
       FROM handyman_chargeable_additional_work_events e
      WHERE e.work_id = $1 AND e.event_type = 'PAYMENT_TRIGGER'`,
    [workId],
  );
  const row = result.rows[0] as {
    id: string;
    work_id: string;
    client_id: string;
    claim_id: string;
    warranty_id: string;
    execution_scope_id: string;
    bast_id: string;
    occurred_at: Date;
  } | undefined;
  if (!row) return null;
  return {
    workId: row.work_id,
    clientId: row.client_id,
    claimId: row.claim_id,
    warrantyId: row.warranty_id,
    executionScopeId: row.execution_scope_id,
    bastId: row.bast_id,
    eventId: row.id,
    emittedAt: row.occurred_at,
  };
}

export const handymanChargeableAdditionalWorkRepository = {
  createWork,
  findWorkById,
  findWorkByClaimId,
  findFreeReworkStatusForClaim,
  listWorksByWarrantyId,
  updateWorkDecision,
  insertWorkEvent,
  findWorkEventByIdempotency,
  findWorkEventByClaimIdempotency,
  findPaymentTriggerEventForWork,
  findPaymentTriggerForWork,
};
