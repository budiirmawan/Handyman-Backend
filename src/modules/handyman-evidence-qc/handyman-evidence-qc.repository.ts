import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanDefectEventRecord,
  HandymanDefectEventType,
  HandymanDefectRecordRecord,
  HandymanDefectStatus,
  HandymanEvidenceEventRecord,
  HandymanEvidenceEventType,
  HandymanEvidenceFileRecord,
  HandymanEvidenceRecordRecord,
  HandymanEvidenceStage,
  HandymanQcItemOutcome,
  HandymanQcRunEventRecord,
  HandymanQcRunEventType,
  HandymanQcRunItemRecord,
  HandymanQcRunRecord,
  HandymanQcRunStatus,
  NewHandymanDefectEvent,
  NewHandymanDefectRecord,
  NewHandymanEvidenceEvent,
  NewHandymanEvidenceFile,
  NewHandymanEvidenceRecord,
  NewHandymanQcRun,
  NewHandymanQcRunEvent,
  NewHandymanQcRunItem,
} from './handyman-evidence-qc.types';

/**
 * CR-HM-10 PART 02 — evidence/QC/defect repository. The ONLY
 * writer of the three aggregates:
 *
 *   handyman_evidence_records (+ _files, + _record_events)
 *   handyman_qc_runs          (+ _run_items, + _run_events)
 *   handyman_defect_records   (+ _defect_events)
 *
 * ZERO QC-outcome evaluation/lifecycle/evidence-policy logic (later
 * PARTs own the command semantics; this layer only persists given
 * server-side input). All head/write timestamps are DB-server clock
 * — callers pass no time except the caller-CLAIMED capture_time for
 * evidence files (server-validated at DB-level via CHECK).
 * NO file bytes persist here — storage references only. ZERO
 * commercial/FM vocabulary exists to persist at this boundary.
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const EVIDENCE_SELECT = `
  SELECT id, client_id, execution_scope_id, session_id, stage,
         description, created_at, updated_at
    FROM handyman_evidence_records`;

const EVIDENCE_FILE_SELECT = `
  SELECT id, record_id, media_kind, storage_key, content_type,
         byte_size, sha256_digest, capture_time, created_at
    FROM handyman_evidence_record_files`;

const EVIDENCE_EVENT_SELECT = `
  SELECT id, record_id, client_id, event_type, idempotency_key,
         actor_user_id, occurred_at, created_at
    FROM handyman_evidence_record_events`;

const QC_RUN_SELECT = `
  SELECT id, client_id, execution_scope_id, session_id,
         checklist_identity, status, created_at, updated_at
    FROM handyman_qc_runs`;

const QC_ITEM_SELECT = `
  SELECT id, run_id, item_key, outcome, note, created_at, updated_at
    FROM handyman_qc_run_items`;

const QC_EVENT_SELECT = `
  SELECT id, run_id, client_id, event_type, idempotency_key,
         actor_user_id, occurred_at, created_at
    FROM handyman_qc_run_events`;

const DEFECT_SELECT = `
  SELECT id, client_id, execution_scope_id, run_id, item_id,
         description, status, created_at, updated_at
    FROM handyman_defect_records`;

const DEFECT_EVENT_SELECT = `
  SELECT id, defect_id, client_id, event_type, idempotency_key,
         actor_user_id, occurred_at, created_at
    FROM handyman_defect_events`;

const PG_UNIQUE_VIOLATION = '23505';
const PG_RAISE_EXCEPTION = 'P0001';

function toTimestamp(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function mapEvidenceRecord(row: Row): HandymanEvidenceRecordRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    sessionId: row.session_id,
    stage: row.stage as HandymanEvidenceStage,
    description: row.description,
    createdAt: toTimestamp(row.created_at) as string,
    updatedAt: toTimestamp(row.updated_at) as string,
  };
}

function mapEvidenceFile(row: Row): HandymanEvidenceFileRecord {
  return {
    id: row.id,
    recordId: row.record_id,
    mediaKind: row.media_kind,
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    sha256Digest: row.sha256_digest,
    captureTime: toTimestamp(row.capture_time),
    createdAt: toTimestamp(row.created_at) as string,
  };
}

function mapEvidenceEvent(row: Row): HandymanEvidenceEventRecord {
  return {
    id: row.id,
    recordId: row.record_id,
    clientId: row.client_id,
    eventType: row.event_type as HandymanEvidenceEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: toTimestamp(row.occurred_at) as string,
    createdAt: toTimestamp(row.created_at) as string,
  };
}

function mapQcRun(row: Row): HandymanQcRunRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    sessionId: row.session_id,
    checklistIdentity: row.checklist_identity,
    status: row.status as HandymanQcRunStatus,
    createdAt: toTimestamp(row.created_at) as string,
    updatedAt: toTimestamp(row.updated_at) as string,
  };
}

function mapQcRunItem(row: Row): HandymanQcRunItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    itemKey: row.item_key,
    outcome: row.outcome as HandymanQcItemOutcome,
    note: row.note,
    createdAt: toTimestamp(row.created_at) as string,
    updatedAt: toTimestamp(row.updated_at) as string,
  };
}

function mapQcRunEvent(row: Row): HandymanQcRunEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    clientId: row.client_id,
    eventType: row.event_type as HandymanQcRunEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: toTimestamp(row.occurred_at) as string,
    createdAt: toTimestamp(row.created_at) as string,
  };
}

function mapDefect(row: Row): HandymanDefectRecordRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    runId: row.run_id,
    itemId: row.item_id,
    description: row.description,
    status: row.status as HandymanDefectStatus,
    createdAt: toTimestamp(row.created_at) as string,
    updatedAt: toTimestamp(row.updated_at) as string,
  };
}

function mapDefectEvent(row: Row): HandymanDefectEventRecord {
  return {
    id: row.id,
    defectId: row.defect_id,
    clientId: row.client_id,
    eventType: row.event_type as HandymanDefectEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: toTimestamp(row.occurred_at) as string,
    createdAt: toTimestamp(row.created_at) as string,
  };
}

/* ---- Evidence record (aggregate A head) ------------------------ */

async function createEvidenceRecord(
  executor: Executor = getPool(),
  record: NewHandymanEvidenceRecord,
): Promise<HandymanEvidenceRecordRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_evidence_records (
       id, client_id, execution_scope_id, session_id, stage,
       description
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, client_id, execution_scope_id, session_id, stage,
               description, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.executionScopeId,
      record.sessionId ?? null,
      record.stage,
      record.description ?? null,
    ],
  );
  return mapEvidenceRecord(result.rows[0]);
}

async function findEvidenceRecordById(
  executor: Executor = getPool(),
  recordId: string,
): Promise<HandymanEvidenceRecordRecord | null> {
  const result = await executor.query(
    `${EVIDENCE_SELECT} WHERE id = $1`,
    [recordId],
  );
  return result.rows[0] ? mapEvidenceRecord(result.rows[0]) : null;
}

/** Row-locking read for later-PART serialized commands. */
async function findEvidenceRecordByIdForUpdate(
  executor: Executor = getPool(),
  recordId: string,
): Promise<HandymanEvidenceRecordRecord | null> {
  const result = await executor.query(
    `${EVIDENCE_SELECT} WHERE id = $1 FOR UPDATE`,
    [recordId],
  );
  return result.rows[0] ? mapEvidenceRecord(result.rows[0]) : null;
}

async function listEvidenceRecordsByScope(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanEvidenceRecordRecord[]> {
  const result = await executor.query(
    `${EVIDENCE_SELECT}
      WHERE execution_scope_id = $1
      ORDER BY created_at, id`,
    [executionScopeId],
  );
  return result.rows.map(mapEvidenceRecord);
}

/** Head mutation primitive: description is the only open column. */
async function updateEvidenceRecordDescription(
  executor: Executor = getPool(),
  recordId: string,
  description: string | null,
): Promise<HandymanEvidenceRecordRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_evidence_records
        SET description = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, execution_scope_id, session_id, stage,
                description, created_at, updated_at`,
    [recordId, description],
  );
  return result.rows[0] ? mapEvidenceRecord(result.rows[0]) : null;
}

/* ---- Evidence files (append-only) ------------------------------ */

/**
 * Appends an evidence file (immutable storage reference; SHA-256 +
 * size/content-type recorded server-side as GIVEN by the service).
 * NO lifecycle gate fires here (pre-finalize enforcement is a
 * later-PART command concern); the identity trigger keeps rows
 * immutable once written.
 */
async function appendEvidenceFile(
  executor: Executor = getPool(),
  record: NewHandymanEvidenceFile,
): Promise<HandymanEvidenceFileRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_evidence_record_files (
       id, record_id, media_kind, storage_key, content_type,
       byte_size, sha256_digest, capture_time
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, record_id, media_kind, storage_key, content_type,
               byte_size, sha256_digest, capture_time, created_at`,
    [
      randomUUID(),
      record.recordId,
      record.mediaKind,
      record.storageKey,
      record.contentType,
      record.byteSize,
      record.sha256Digest,
      record.captureTime ?? null,
    ],
  );
  return mapEvidenceFile(result.rows[0]);
}

async function listEvidenceFilesByRecord(
  executor: Executor = getPool(),
  recordId: string,
): Promise<HandymanEvidenceFileRecord[]> {
  const result = await executor.query(
    `${EVIDENCE_FILE_SELECT}
      WHERE record_id = $1
      ORDER BY created_at, id`,
    [recordId],
  );
  return result.rows.map(mapEvidenceFile);
}

async function findEvidenceFileByStorageKey(
  executor: Executor = getPool(),
  storageKey: string,
): Promise<HandymanEvidenceFileRecord | null> {
  const result = await executor.query(
    `${EVIDENCE_FILE_SELECT} WHERE storage_key = $1`,
    [storageKey],
  );
  return result.rows[0] ? mapEvidenceFile(result.rows[0]) : null;
}

/* ---- Evidence events (append-only) ----------------------------- */

async function appendEvidenceEvent(
  executor: Executor = getPool(),
  record: NewHandymanEvidenceEvent,
): Promise<HandymanEvidenceEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_evidence_record_events (
       id, record_id, client_id, event_type, idempotency_key,
       actor_user_id, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, record_id, client_id, event_type,
               idempotency_key, actor_user_id, occurred_at,
               created_at`,
    [
      randomUUID(),
      record.recordId,
      record.clientId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapEvidenceEvent(result.rows[0]);
}

async function findEvidenceEventByIdempotency(
  executor: Executor = getPool(),
  recordId: string,
  eventType: HandymanEvidenceEventType,
  idempotencyKey: string,
): Promise<HandymanEvidenceEventRecord | null> {
  const result = await executor.query(
    `${EVIDENCE_EVENT_SELECT}
      WHERE record_id = $1 AND event_type = $2
        AND idempotency_key = $3`,
    [recordId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvidenceEvent(result.rows[0]) : null;
}

async function listEvidenceEventsByRecord(
  executor: Executor = getPool(),
  recordId: string,
): Promise<HandymanEvidenceEventRecord[]> {
  const result = await executor.query(
    `${EVIDENCE_EVENT_SELECT}
      WHERE record_id = $1 ORDER BY occurred_at, created_at, id`,
    [recordId],
  );
  return result.rows.map(mapEvidenceEvent);
}

/**
 * CREATE replay lookup for PART 03: a CREATE command's idempotency
 * key is scoped by the EXECUTION SCOPE (the record does not exist
 * yet). Returns the originally-created record + its CREATE event,
 * or null when the key was never applied on this scope.
 */
async function findEvidenceCreateReplayByScope(
  executor: Executor = getPool(),
  executionScopeId: string,
  idempotencyKey: string,
): Promise<{
  record: HandymanEvidenceRecordRecord;
  event: HandymanEvidenceEventRecord;
} | null> {
  const result = await executor.query(
    `SELECT r.id            AS r_id,
            r.client_id     AS r_client_id,
            r.execution_scope_id AS r_scope_id,
            r.session_id    AS r_session_id,
            r.stage         AS r_stage,
            r.description   AS r_description,
            r.created_at    AS r_created_at,
            r.updated_at    AS r_updated_at,
            e.id            AS e_id,
            e.record_id     AS e_record_id,
            e.client_id     AS e_client_id,
            e.event_type    AS e_event_type,
            e.idempotency_key AS e_idempotency_key,
            e.actor_user_id AS e_actor_user_id,
            e.occurred_at   AS e_occurred_at,
            e.created_at    AS e_created_at
       FROM handyman_evidence_record_events e
       JOIN handyman_evidence_records r ON r.id = e.record_id
      WHERE r.execution_scope_id = $1
        AND e.event_type = 'CREATE'
        AND e.idempotency_key = $2
      ORDER BY e.created_at, e.id
      LIMIT 1`,
    [executionScopeId, idempotencyKey],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    record: {
      id: row.r_id,
      clientId: row.r_client_id,
      executionScopeId: row.r_scope_id,
      sessionId: row.r_session_id,
      stage: row.r_stage as HandymanEvidenceStage,
      description: row.r_description,
      createdAt: toTimestamp(row.r_created_at) as string,
      updatedAt: toTimestamp(row.r_updated_at) as string,
    },
    event: {
      id: row.e_id,
      recordId: row.e_record_id,
      clientId: row.e_client_id,
      eventType: row.e_event_type as HandymanEvidenceEventType,
      idempotencyKey: row.e_idempotency_key,
      actorUserId: row.e_actor_user_id,
      occurredAt: toTimestamp(row.e_occurred_at) as string,
      createdAt: toTimestamp(row.e_created_at) as string,
    },
  };
}

/**
 * FINALIZE stable-state check (D6 file-set lock): the record has an
 * implicit lifecycle (no status column) — FINALIZED state IS the
 * presence of a FINALIZE event. Returns that event or null.
 */
async function findEvidenceFinalizeEventByRecord(
  executor: Executor = getPool(),
  recordId: string,
): Promise<HandymanEvidenceEventRecord | null> {
  const result = await executor.query(
    `${EVIDENCE_EVENT_SELECT}
      WHERE record_id = $1 AND event_type = 'FINALIZE'
      ORDER BY occurred_at, created_at, id
      LIMIT 1`,
    [recordId],
  );
  return result.rows[0] ? mapEvidenceEvent(result.rows[0]) : null;
}

/* ---- QC runs (aggregate B head) -------------------------------- */

async function createQcRun(
  executor: Executor = getPool(),
  record: NewHandymanQcRun,
): Promise<HandymanQcRunRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_qc_runs (
       id, client_id, execution_scope_id, session_id,
       checklist_identity, status
     ) VALUES ($1, $2, $3, $4, $5, 'OPEN')
     RETURNING id, client_id, execution_scope_id, session_id,
               checklist_identity, status, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.executionScopeId,
      record.sessionId ?? null,
      record.checklistIdentity,
    ],
  );
  return mapQcRun(result.rows[0]);
}

async function findQcRunById(
  executor: Executor = getPool(),
  runId: string,
): Promise<HandymanQcRunRecord | null> {
  const result = await executor.query(
    `${QC_RUN_SELECT} WHERE id = $1`,
    [runId],
  );
  return result.rows[0] ? mapQcRun(result.rows[0]) : null;
}

async function findQcRunByIdForUpdate(
  executor: Executor = getPool(),
  runId: string,
): Promise<HandymanQcRunRecord | null> {
  const result = await executor.query(
    `${QC_RUN_SELECT} WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  return result.rows[0] ? mapQcRun(result.rows[0]) : null;
}

async function findOpenQcRunByScope(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanQcRunRecord | null> {
  const result = await executor.query(
    `${QC_RUN_SELECT}
      WHERE execution_scope_id = $1 AND status = 'OPEN'
      ORDER BY created_at, id LIMIT 1`,
    [executionScopeId],
  );
  return result.rows[0] ? mapQcRun(result.rows[0]) : null;
}

async function listQcRunsByScope(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanQcRunRecord[]> {
  const result = await executor.query(
    `${QC_RUN_SELECT}
      WHERE execution_scope_id = $1
      ORDER BY created_at, id`,
    [executionScopeId],
  );
  return result.rows.map(mapQcRun);
}

/** Head mutation primitive: status ONLY (OPEN -> PASSED|FAILED). */
async function updateQcRunStatus(
  executor: Executor = getPool(),
  runId: string,
  status: HandymanQcRunStatus,
): Promise<HandymanQcRunRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_qc_runs
        SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, execution_scope_id, session_id,
                checklist_identity, status, created_at, updated_at`,
    [runId, status],
  );
  return result.rows[0] ? mapQcRun(result.rows[0]) : null;
}

/* ---- QC run items ---------------------------------------------- */

/**
 * Upserts one check-item outcome entry (unique per (run_id,
 * item_key)): ITEM_SET semantics — the caller already decided the
 * outcome; persistence just stores it with a fresh server
 * updated_at. Distinct INSERT-vs-UPDATE shapes come back via the
 * optional `inserted` flag.
 */
async function setQcRunItemOutcome(
  executor: Executor = getPool(),
  record: NewHandymanQcRunItem,
): Promise<HandymanQcRunItemRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_qc_run_items (
       id, run_id, item_key, outcome, note
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id, item_key) DO UPDATE
        SET outcome = EXCLUDED.outcome,
            note = EXCLUDED.note,
            updated_at = NOW()
     RETURNING id, run_id, item_key, outcome, note, created_at,
               updated_at`,
    [
      randomUUID(),
      record.runId,
      record.itemKey,
      record.outcome,
      record.note ?? null,
    ],
  );
  return mapQcRunItem(result.rows[0]);
}

async function listQcRunItems(
  executor: Executor = getPool(),
  runId: string,
): Promise<HandymanQcRunItemRecord[]> {
  const result = await executor.query(
    `${QC_ITEM_SELECT}
      WHERE run_id = $1
      ORDER BY item_key, created_at, id`,
    [runId],
  );
  return result.rows.map(mapQcRunItem);
}

/* ---- QC run events (append-only) ------------------------------- */

async function appendQcRunEvent(
  executor: Executor = getPool(),
  record: NewHandymanQcRunEvent,
): Promise<HandymanQcRunEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_qc_run_events (
       id, run_id, client_id, event_type, idempotency_key,
       actor_user_id, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, run_id, client_id, event_type,
               idempotency_key, actor_user_id, occurred_at,
               created_at`,
    [
      randomUUID(),
      record.runId,
      record.clientId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapQcRunEvent(result.rows[0]);
}

async function findQcRunEventByIdempotency(
  executor: Executor = getPool(),
  runId: string,
  eventType: HandymanQcRunEventType,
  idempotencyKey: string,
): Promise<HandymanQcRunEventRecord | null> {
  const result = await executor.query(
    `${QC_EVENT_SELECT}
      WHERE run_id = $1 AND event_type = $2
        AND idempotency_key = $3`,
    [runId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapQcRunEvent(result.rows[0]) : null;
}

async function listQcRunEvents(
  executor: Executor = getPool(),
  runId: string,
): Promise<HandymanQcRunEventRecord[]> {
  const result = await executor.query(
    `${QC_EVENT_SELECT}
      WHERE run_id = $1 ORDER BY occurred_at, created_at, id`,
    [runId],
  );
  return result.rows.map(mapQcRunEvent);
}

/**
 * OPEN replay lookup for PART 04: an OPEN command's idempotency key
 * is scoped by the EXECUTION SCOPE (the run does not exist yet).
 * Returns the originally-created run + its OPEN event, or null.
 */
async function findQcOpenReplayByScope(
  executor: Executor = getPool(),
  executionScopeId: string,
  idempotencyKey: string,
): Promise<{
  run: HandymanQcRunRecord;
  event: HandymanQcRunEventRecord;
} | null> {
  const result = await executor.query(
    `SELECT r.id            AS r_id,
            r.client_id     AS r_client_id,
            r.execution_scope_id AS r_scope_id,
            r.session_id    AS r_session_id,
            r.checklist_identity AS r_checklist_identity,
            r.status        AS r_status,
            r.created_at    AS r_created_at,
            r.updated_at    AS r_updated_at,
            e.id            AS e_id,
            e.run_id        AS e_run_id,
            e.client_id     AS e_client_id,
            e.event_type    AS e_event_type,
            e.idempotency_key AS e_idempotency_key,
            e.actor_user_id AS e_actor_user_id,
            e.occurred_at   AS e_occurred_at,
            e.created_at    AS e_created_at
       FROM handyman_qc_run_events e
       JOIN handyman_qc_runs r ON r.id = e.run_id
      WHERE r.execution_scope_id = $1
        AND e.event_type = 'OPEN'
        AND e.idempotency_key = $2
      ORDER BY e.created_at, e.id
      LIMIT 1`,
    [executionScopeId, idempotencyKey],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    run: {
      id: row.r_id,
      clientId: row.r_client_id,
      executionScopeId: row.r_scope_id,
      sessionId: row.r_session_id,
      checklistIdentity: row.r_checklist_identity,
      status: row.r_status as HandymanQcRunStatus,
      createdAt: toTimestamp(row.r_created_at) as string,
      updatedAt: toTimestamp(row.r_updated_at) as string,
    },
    event: {
      id: row.e_id,
      runId: row.e_run_id,
      clientId: row.e_client_id,
      eventType: row.e_event_type as HandymanQcRunEventType,
      idempotencyKey: row.e_idempotency_key,
      actorUserId: row.e_actor_user_id,
      occurredAt: toTimestamp(row.e_occurred_at) as string,
      createdAt: toTimestamp(row.e_created_at) as string,
    },
  };
}

/* ---- Defect records (aggregate C head) ------------------------- */

async function createDefectRecord(
  executor: Executor = getPool(),
  record: NewHandymanDefectRecord,
): Promise<HandymanDefectRecordRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_defect_records (
       id, client_id, execution_scope_id, run_id, item_id,
       description, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 'OPENED')
     RETURNING id, client_id, execution_scope_id, run_id, item_id,
               description, status, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.executionScopeId,
      record.runId ?? null,
      record.itemId ?? null,
      record.description,
    ],
  );
  return mapDefect(result.rows[0]);
}

async function findDefectById(
  executor: Executor = getPool(),
  defectId: string,
): Promise<HandymanDefectRecordRecord | null> {
  const result = await executor.query(
    `${DEFECT_SELECT} WHERE id = $1`,
    [defectId],
  );
  return result.rows[0] ? mapDefect(result.rows[0]) : null;
}

async function findDefectByIdForUpdate(
  executor: Executor = getPool(),
  defectId: string,
): Promise<HandymanDefectRecordRecord | null> {
  const result = await executor.query(
    `${DEFECT_SELECT} WHERE id = $1 FOR UPDATE`,
    [defectId],
  );
  return result.rows[0] ? mapDefect(result.rows[0]) : null;
}

async function listDefectsByScope(
  executor: Executor = getPool(),
  executionScopeId: string,
): Promise<HandymanDefectRecordRecord[]> {
  const result = await executor.query(
    `${DEFECT_SELECT}
      WHERE execution_scope_id = $1
      ORDER BY created_at, id`,
    [executionScopeId],
  );
  return result.rows.map(mapDefect);
}

/** Head mutation primitive: status ONLY (frozen ladder). */
async function updateDefectStatus(
  executor: Executor = getPool(),
  defectId: string,
  status: HandymanDefectStatus,
): Promise<HandymanDefectRecordRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_defect_records
        SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, execution_scope_id, run_id, item_id,
                description, status, created_at, updated_at`,
    [defectId, status],
  );
  return result.rows[0] ? mapDefect(result.rows[0]) : null;
}

/* ---- Defect events (append-only) ------------------------------- */

async function appendDefectEvent(
  executor: Executor = getPool(),
  record: NewHandymanDefectEvent,
): Promise<HandymanDefectEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_defect_events (
       id, defect_id, client_id, event_type, idempotency_key,
       actor_user_id, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, defect_id, client_id, event_type,
               idempotency_key, actor_user_id, occurred_at,
               created_at`,
    [
      randomUUID(),
      record.defectId,
      record.clientId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapDefectEvent(result.rows[0]);
}

async function findDefectEventByIdempotency(
  executor: Executor = getPool(),
  defectId: string,
  eventType: HandymanDefectEventType,
  idempotencyKey: string,
): Promise<HandymanDefectEventRecord | null> {
  const result = await executor.query(
    `${DEFECT_EVENT_SELECT}
      WHERE defect_id = $1 AND event_type = $2
        AND idempotency_key = $3`,
    [defectId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapDefectEvent(result.rows[0]) : null;
}

async function listDefectEvents(
  executor: Executor = getPool(),
  defectId: string,
): Promise<HandymanDefectEventRecord[]> {
  const result = await executor.query(
    `${DEFECT_EVENT_SELECT}
      WHERE defect_id = $1 ORDER BY occurred_at, created_at, id`,
    [defectId],
  );
  return result.rows.map(mapDefectEvent);
}

export { PG_RAISE_EXCEPTION, PG_UNIQUE_VIOLATION };

export const handymanEvidenceQcRepository = {
  createEvidenceRecord,
  findEvidenceRecordById,
  findEvidenceRecordByIdForUpdate,
  listEvidenceRecordsByScope,
  updateEvidenceRecordDescription,
  appendEvidenceFile,
  listEvidenceFilesByRecord,
  findEvidenceFileByStorageKey,
  appendEvidenceEvent,
  findEvidenceEventByIdempotency,
  listEvidenceEventsByRecord,
  findEvidenceCreateReplayByScope,
  findEvidenceFinalizeEventByRecord,
  createQcRun,
  findQcRunById,
  findQcRunByIdForUpdate,
  findOpenQcRunByScope,
  listQcRunsByScope,
  updateQcRunStatus,
  setQcRunItemOutcome,
  listQcRunItems,
  appendQcRunEvent,
  findQcRunEventByIdempotency,
  listQcRunEvents,
  findQcOpenReplayByScope,
  createDefectRecord,
  findDefectById,
  findDefectByIdForUpdate,
  listDefectsByScope,
  updateDefectStatus,
  appendDefectEvent,
  findDefectEventByIdempotency,
  listDefectEvents,
};
