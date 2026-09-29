import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { isManagedStorageKey } from '../evidence/storage';
import {
  handymanExecutionScopeNotFoundError,
  handymanExecutionScopeRepository,
} from '../handyman-quotations';
import { resolveHandymanAssignmentLead }
  from '../handyman-scope-assignments';
import {
  handymanEvidenceAlreadyFinalizedError,
  handymanEvidenceIdempotencyConflictError,
  handymanEvidenceNotAuthorizedError,
  handymanEvidenceRecordNotFoundError,
  handymanEvidenceStorageKeyConflictError,
  handymanEvidenceValidationError,
  handymanQcIdempotencyConflictError,
  handymanQcNotAuthorizedError,
  handymanQcRunAlreadyOpenError,
  handymanQcRunIllegalTransitionError,
  handymanQcRunNotFoundError,
  handymanDefectIdempotencyConflictError,
  handymanDefectIllegalTransitionError,
  handymanDefectNotAuthorizedError,
  handymanDefectNotFoundError,
} from './handyman-evidence-qc.errors';
import { handymanEvidenceQcRepository }
  from './handyman-evidence-qc.repository';
import {
  HANDYMAN_EVIDENCE_MEDIA_KINDS,
  HANDYMAN_EVIDENCE_STAGES,
  HANDYMAN_QC_ITEM_OUTCOMES,
} from './handyman-evidence-qc.types';
import type {
  HandymanDefectEventRecord,
  HandymanDefectEventType,
  HandymanDefectRecordRecord,
  HandymanDefectStatus,
  HandymanEvidenceEventRecord,
  HandymanEvidenceFileRecord,
  HandymanEvidenceMediaKind,
  HandymanEvidenceRecordRecord,
  HandymanEvidenceStage,
  HandymanQcItemOutcome,
  HandymanQcRunEventRecord,
  HandymanQcRunItemRecord,
  HandymanQcRunRecord,
  HandymanQcRunStatus,
} from './handyman-evidence-qc.types';

/**
 * CR-HM-10 PART 03 — EVIDENCE commands ONLY (FROZEN governance
 * `CR-HM-10_START_GOVERNANCE.md` D2–D7): CREATE record (stage-bounded
 * to the frozen 7-stage vocabulary), FILE_ADD (MIME/size/SHA-256
 * server-validated; pre-finalize only), FINALIZE (locks the file
 * set). NO QC commands, NO defect commands, NO HTTP/OpenAPI (later
 * PARTs own those).
 *
 * Authority (D4/D7 — mirrors PART 03–05 preambles): authenticated
 * actor → client-access wall → scope 404 → CURRENT authoritative
 * Crew Lead (`resolveHandymanAssignmentLead`; helper members are
 * insufficient). Every command = one transaction holding the
 * aggregate-head row lock: replay-check → stable-state check →
 * head-write → event-append → commit. Idempotency replay of the
 * same key returns the SAME rows with `replayed: true`, never a
 * second row; replay with a DIFFERENT shape is a bounded 409
 * conflict. All persisted timestamps are server-clock; the only
 * caller-claimed timestamp is `captureTime` (bounded ≤ server-now
 * + 5 minutes, D6). ZERO commercial vocabulary and ZERO FM coupling
 * — storage keys follow the shared `evidence/storage` key
 * discipline (value binding, never ORM).
 */

/** Bounded mirror of the shared evidence engine size boundary. */
const MAX_FILE_BYTES = 52_428_800;

/** Bounded MIME mirror per media kind (evidence-engine policy). */
const MIME_BY_MEDIA_KIND: Record<HandymanEvidenceMediaKind,
readonly string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  DOCUMENT: ['application/pdf', 'image/jpeg', 'image/png'],
  VIDEO: ['video/mp4', 'video/quicktime'],
};

/** D6: caller-claimed capture_time skew allowance. */
const CAPTURE_TIME_SKEW_MS = 5 * 60 * 1000;

function ensureUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw handymanEvidenceValidationError(field);
  }
  return value;
}

function ensureKey(value: string): string {
  if (typeof value !== 'string'
      || value.trim().length === 0 || value.length > 128) {
    throw handymanEvidenceValidationError('idempotencyKey');
  }
  return value;
}

function ensureStage(value: string): HandymanEvidenceStage {
  if (!(HANDYMAN_EVIDENCE_STAGES as readonly string[])
    .includes(value)) {
    throw handymanEvidenceValidationError('stage');
  }
  return value as HandymanEvidenceStage;
}

function ensureMediaKind(value: string): HandymanEvidenceMediaKind {
  if (!(HANDYMAN_EVIDENCE_MEDIA_KINDS as readonly string[])
    .includes(value)) {
    throw handymanEvidenceValidationError('mediaKind');
  }
  return value as HandymanEvidenceMediaKind;
}

function ensureContentType(
  value: string,
  mediaKind: HandymanEvidenceMediaKind,
): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase()
    : '';
  if (!MIME_BY_MEDIA_KIND[mediaKind].includes(raw)) {
    throw handymanEvidenceValidationError('contentType');
  }
  return raw;
}

function ensureByteSize(value: number): number {
  if (!Number.isInteger(value) || value <= 0
      || value > MAX_FILE_BYTES) {
    throw handymanEvidenceValidationError('byteSize');
  }
  return value;
}

function ensureSha256(value: string): string {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{64}$/i.test(value)) {
    throw handymanEvidenceValidationError('sha256Digest');
  }
  return value.toLowerCase();
}

function ensureStorageKey(value: string): string {
  if (typeof value !== 'string' || !isManagedStorageKey(value)) {
    throw handymanEvidenceValidationError('storageKey');
  }
  return value;
}

/** Server-side capture_time bound (D6: ≤ server-now + 5 minutes). */
function ensureCaptureTime(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const claimed = new Date(value);
  if (Number.isNaN(claimed.getTime())
      || claimed.getTime() > Date.now() + CAPTURE_TIME_SKEW_MS) {
    throw handymanEvidenceValidationError('captureTime');
  }
  return claimed.toISOString();
}

/**
 * Shared authority preamble for PART 03 commands: scope exists (+404),
 * client context wall (403 BUILDING_ACCESS_DENIED), CURRENT Crew Lead
 * resolution (403 *_NOT_AUTHORIZED; helper members insufficient).
 */
async function authorityPreamble(
  scopeUuid: string,
  actorUserId: string,
) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId,
    scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }
  const resolution = await resolveHandymanAssignmentLead(
    scopeUuid,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw handymanEvidenceNotAuthorizedError();
  }
  return { scope, resolution };
}

/**
 * Session provenance binding: the optional session id must name a
 * work session ON this scope (server-side verified; never trusted
 * via caller claim alone — the DB consistency trigger is the final
 * wall, this check produces the bounded 400 reason).
 */
async function ensureSessionBinding(
  sessionId: string | null,
  scopeUuid: string,
): Promise<string | null> {
  if (sessionId === null) return null;
  const result = await getPool().query(
    `SELECT id FROM handyman_work_sessions
      WHERE id = $1 AND execution_scope_id = $2`,
    [sessionId, scopeUuid],
  );
  if (result.rows.length === 0) {
    throw handymanEvidenceValidationError('sessionId');
  }
  return sessionId;
}

/* ---- CREATE ----------------------------------------------------- */

export type CreateHandymanEvidenceRecordInput = {
  executionScopeId: string;
  stage: HandymanEvidenceStage;
  description?: string | null;
  sessionId?: string | null;
  idempotencyKey: string;
};

export type HandymanEvidenceCommandResult = {
  record: HandymanEvidenceRecordRecord;
  event: HandymanEvidenceEventRecord;
  replayed: boolean;
};

/**
 * CREATE (D2/D3/D6): stage-bounded evidence head + CREATE event,
 * one atomic transaction. The record exists upon CREATE; there is
 * NO status column (implicit lifecycle — D3). Replay of the same
 * key replays the SAME record/event; a same-key/different-shape
 * replay is a bounded 409 conflict.
 */
export async function createHandymanEvidenceRecord(
  input: CreateHandymanEvidenceRecordInput,
  actorUserId: string,
): Promise<HandymanEvidenceCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const stage = ensureStage(input.stage);
  const description = input.description === undefined
    ? null
    : input.description;
  if (description !== null && typeof description !== 'string') {
    throw handymanEvidenceValidationError('description');
  }
  const sessionRaw = input.sessionId === undefined
    ? null
    : input.sessionId;
  const sessionId = sessionRaw === null
    ? null
    : ensureUuid(sessionRaw, 'sessionId');
  const { scope } = await authorityPreamble(scopeUuid, actorUuid);
  const boundSessionId = await ensureSessionBinding(sessionId,
    scopeUuid);

  return withTransaction(async (tx: PoolClient) => {
    const replay = await handymanEvidenceQcRepository
      .findEvidenceCreateReplayByScope(tx, scopeUuid, key);
    if (replay) {
      // Same key must replay the SAME shape (subset equality on the
      // observable command parameters).
      if (replay.record.stage !== stage
          || (replay.record.sessionId ?? null) !== boundSessionId
          || (replay.record.description ?? null) !== description) {
        throw handymanEvidenceIdempotencyConflictError();
      }
      return { record: replay.record, event: replay.event,
        replayed: true };
    }
    const record = await handymanEvidenceQcRepository
      .createEvidenceRecord(tx, {
        clientId: scope.clientId,
        executionScopeId: scopeUuid,
        sessionId: boundSessionId,
        stage,
        description,
      });
    const event = await handymanEvidenceQcRepository
      .appendEvidenceEvent(tx, {
        recordId: record.id,
        clientId: scope.clientId,
        eventType: 'CREATE',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { record, event, replayed: false };
  });
}

/* ---- FILE_ADD --------------------------------------------------- */

export type AddHandymanEvidenceFileInput = {
  evidenceRecordId: string;
  mediaKind: HandymanEvidenceMediaKind;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256Digest: string;
  captureTime?: string | null;
  idempotencyKey: string;
};

export type HandymanEvidenceFileAddResult = {
  file: HandymanEvidenceFileRecord;
  event: HandymanEvidenceEventRecord;
  replayed: boolean;
};

/**
 * FILE_ADD (D2/D6): append one immutable storage reference to a
 * record. The file set is mutable ONLY pre-FINALIZE (bounded 409
 * afterwards; D6). MIME kind, size ceiling, SHA-256 digest format,
 * storage-key discipline, and capture_time skew are ALL
 * server-validated — the DB CHECK/UNIQUE surfaces are the final
 * wall, this command produces the bounded 400/409 reasons.
 */
export async function addHandymanEvidenceFile(
  input: AddHandymanEvidenceFileInput,
  actorUserId: string,
): Promise<HandymanEvidenceFileAddResult> {
  const recordUuid = ensureUuid(input.evidenceRecordId,
    'evidenceRecordId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const mediaKind = ensureMediaKind(input.mediaKind);
  const contentType = ensureContentType(input.contentType, mediaKind);
  const byteSize = ensureByteSize(input.byteSize);
  const sha256Digest = ensureSha256(input.sha256Digest);
  const storageKey = ensureStorageKey(input.storageKey);
  const captureTime = ensureCaptureTime(input.captureTime);

  return withTransaction(async (tx: PoolClient) => {
    // Row-lock the aggregate head first (D7 serialization).
    const record = await handymanEvidenceQcRepository
      .findEvidenceRecordByIdForUpdate(tx, recordUuid);
    if (!record) throw handymanEvidenceRecordNotFoundError();
    await authorityPreamble(record.executionScopeId, actorUuid);

    // Replay BEFORE stable-state check: a recorded FILE_ADD with the
    // same key replays the original file/event.
    const replayEvent = await handymanEvidenceQcRepository
      .findEvidenceEventByIdempotency(tx, recordUuid, 'FILE_ADD',
        key);
    if (replayEvent) {
      const files = await handymanEvidenceQcRepository
        .listEvidenceFilesByRecord(tx, recordUuid);
      const file = files.find((candidate) =>
        candidate.storageKey === storageKey)
        ?? null;
      if (!file) {
        // Same key, different storage key detail — never coin id.
        const byDigest = files.find((candidate) =>
          candidate.sha256Digest === sha256Digest) ?? null;
        if (!byDigest) {
          throw handymanEvidenceIdempotencyConflictError();
        }
        return { file: byDigest, event: replayEvent, replayed: true };
      }
      return { file, event: replayEvent, replayed: true };
    }

    // Stable-state (D6): post-FINALIZE the file set is locked.
    if (await handymanEvidenceQcRepository
      .findEvidenceFinalizeEventByRecord(tx, recordUuid)) {
      throw handymanEvidenceAlreadyFinalizedError();
    }

    // Storage-key uniqueness beyond this record is a bounded 409
    // upfront (the DB UNIQUE is the final wall inside the same tx).
    const existingAnywhere = await handymanEvidenceQcRepository
      .findEvidenceFileByStorageKey(tx, storageKey);
    if (existingAnywhere) {
      throw handymanEvidenceStorageKeyConflictError();
    }

    const file = await handymanEvidenceQcRepository
      .appendEvidenceFile(tx, {
        recordId: recordUuid,
        mediaKind,
        storageKey,
        contentType,
        byteSize,
        sha256Digest,
        captureTime,
      });
    const event = await handymanEvidenceQcRepository
      .appendEvidenceEvent(tx, {
        recordId: recordUuid,
        clientId: record.clientId,
        eventType: 'FILE_ADD',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { file, event, replayed: false };
  });
}

/* ---- FINALIZE --------------------------------------------------- */

export type FinalizeHandymanEvidenceRecordInput = {
  evidenceRecordId: string;
  idempotencyKey: string;
};

/**
 * FINALIZE (D3/D6): appends the FINALIZE event — the record has an
 * implicit lifecycle (no status column), so FINALIZE IS the event;
 * afterwards the file set is LOCKED (further FILE_ADD/FINALIZE with
 * a new key is a bounded 409; replay with the same key returns the
 * SAME rows). Nothing is deleted or rewritten.
 */
export async function finalizeHandymanEvidenceRecord(
  input: FinalizeHandymanEvidenceRecordInput,
  actorUserId: string,
): Promise<HandymanEvidenceCommandResult> {
  const recordUuid = ensureUuid(input.evidenceRecordId,
    'evidenceRecordId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  return withTransaction(async (tx: PoolClient) => {
    const record = await handymanEvidenceQcRepository
      .findEvidenceRecordByIdForUpdate(tx, recordUuid);
    if (!record) throw handymanEvidenceRecordNotFoundError();
    await authorityPreamble(record.executionScopeId, actorUuid);

    const finalizeEvent = await handymanEvidenceQcRepository
      .findEvidenceFinalizeEventByRecord(tx, recordUuid);
    if (finalizeEvent) {
      // Replay of the same FINALIZE key replays the SAME event;
      // a different key is a bounded 409 (already locked).
      if (finalizeEvent.idempotencyKey === key) {
        return { record, event: finalizeEvent, replayed: true };
      }
      throw handymanEvidenceAlreadyFinalizedError();
    }

    const event = await handymanEvidenceQcRepository
      .appendEvidenceEvent(tx, {
        recordId: recordUuid,
        clientId: record.clientId,
        eventType: 'FINALIZE',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { record, event, replayed: false };
  });
}

/* ---- Reads (D4: Lead-gated projections over committed state) ---- */

export type HandymanEvidenceRecordView = {
  record: HandymanEvidenceRecordRecord;
  fileCount: number;
  finalized: boolean;
};

/**
 * Per-scope evidence listing (D7 readers): committed records with
 * file counts and FINALIZED projection, Lead-gated. READ-ONLY —
 * zero stateful projection, zero fabrication.
 */
export async function listHandymanEvidenceRecordsByScope(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanEvidenceRecordView[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await authorityPreamble(scopeUuid, actorUuid);
  const records = await handymanEvidenceQcRepository
    .listEvidenceRecordsByScope(undefined, scopeUuid);
  const views = [] as HandymanEvidenceRecordView[];
  for (const record of records) {
    const files = await handymanEvidenceQcRepository
      .listEvidenceFilesByRecord(undefined, record.id);
    const finalized = Boolean(await handymanEvidenceQcRepository
      .findEvidenceFinalizeEventByRecord(undefined, record.id));
    views.push({ record, fileCount: files.length, finalized });
  }
  return views;
}

export type HandymanEvidenceRecordDetailView = {
  record: HandymanEvidenceRecordRecord;
  files: HandymanEvidenceFileRecord[];
  events: HandymanEvidenceEventRecord[];
  finalized: boolean;
};

/**
 * Single-record detail (D7 readers): record + tamper-evident file
 * references (SHA-256 digests) + the append-only event chain,
 * Lead-gated, READ-ONLY.
 */
export async function getHandymanEvidenceRecordDetail(
  evidenceRecordId: string,
  actorUserId: string,
): Promise<HandymanEvidenceRecordDetailView> {
  const recordUuid = ensureUuid(evidenceRecordId, 'evidenceRecordId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const record = await handymanEvidenceQcRepository
    .findEvidenceRecordById(undefined, recordUuid);
  if (!record) throw handymanEvidenceRecordNotFoundError();
  await authorityPreamble(record.executionScopeId, actorUuid);
  const files = await handymanEvidenceQcRepository
    .listEvidenceFilesByRecord(undefined, recordUuid);
  const events = await handymanEvidenceQcRepository
    .listEvidenceEventsByRecord(undefined, recordUuid);
  const finalized = events.some((event) =>
    event.eventType === 'FINALIZE');
  return { record, files, events, finalized };
}

/* ==================================================================
 * CR-HM-10 PART 04 — QC commands ONLY (governance PART 03):
 * OPEN run, ITEM_SET, FINISH (server-evaluated), run+item read
 * models. ONE OPEN run per scope (bounded 409 on a second).
 * Reopening is FORBIDDEN — a new run is a fresh OPEN row (history
 * is additive). NO defect commands here (later PART).
 * ================================================================== */

function ensureOutcome(value: string): HandymanQcItemOutcome {
  if (!(HANDYMAN_QC_ITEM_OUTCOMES as readonly string[])
    .includes(value)) {
    throw handymanEvidenceValidationError('outcome');
  }
  return value as HandymanQcItemOutcome;
}

function ensureItemKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 128) {
    throw handymanEvidenceValidationError('itemKey');
  }
  return raw;
}

function ensureChecklistIdentity(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanEvidenceValidationError('checklistIdentity');
  }
  return raw;
}

/**
 * Same preamble as PART 03 but 403 maps to the QC vocabulary —
 * identical authority chain, module-local error code only.
 */
async function qcAuthorityPreamble(
  scopeUuid: string,
  actorUserId: string,
) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId,
    scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }
  const resolution = await resolveHandymanAssignmentLead(
    scopeUuid,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw handymanQcNotAuthorizedError();
  }
  return { scope, resolution };
}

/* ---- QC OPEN ---------------------------------------------------- */

export type OpenHandymanQcRunInput = {
  executionScopeId: string;
  checklistIdentity: string;
  sessionId?: string | null;
  idempotencyKey: string;
};

export type HandymanQcOpenResult = {
  run: HandymanQcRunRecord;
  event: HandymanQcRunEventRecord;
  replayed: boolean;
};

/**
 * OPEN (D3): ONE OPEN run per scope — a second OPEN (fresh key) is
 * a bounded 409 ALREADY_OPEN (the DB partial-unique index is the
 * final wall inside the transaction). Replay of the same key +
 * same shape returns the SAME run/event; same key + different
 * shape is a bounded 409 idempotency conflict.
 */
export async function openHandymanQcRun(
  input: OpenHandymanQcRunInput,
  actorUserId: string,
): Promise<HandymanQcOpenResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const checklistIdentity = ensureChecklistIdentity(
    input.checklistIdentity);
  const sessionRaw = input.sessionId === undefined
    ? null
    : input.sessionId;
  const sessionId = sessionRaw === null
    ? null
    : ensureUuid(sessionRaw, 'sessionId');
  const { scope } = await qcAuthorityPreamble(scopeUuid, actorUuid);
  const boundSessionId = await ensureSessionBinding(sessionId,
    scopeUuid);

  return withTransaction(async (tx: PoolClient) => {
    const replay = await handymanEvidenceQcRepository
      .findQcOpenReplayByScope(tx, scopeUuid, key);
    if (replay) {
      if (replay.run.checklistIdentity !== checklistIdentity
          || (replay.run.sessionId ?? null) !== boundSessionId) {
        throw handymanQcIdempotencyConflictError();
      }
      return { run: replay.run, event: replay.event,
        replayed: true };
    }
    // ONE OPEN per scope: any existing OPEN run (different key) is
    // a bounded 409; replay handled above.
    const openRun = await handymanEvidenceQcRepository
      .findOpenQcRunByScope(tx, scopeUuid);
    if (openRun) throw handymanQcRunAlreadyOpenError();
    const run = await handymanEvidenceQcRepository
      .createQcRun(tx, {
        clientId: scope.clientId,
        executionScopeId: scopeUuid,
        sessionId: boundSessionId,
        checklistIdentity,
      });
    const event = await handymanEvidenceQcRepository
      .appendQcRunEvent(tx, {
        runId: run.id,
        clientId: scope.clientId,
        eventType: 'OPEN',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { run, event, replayed: false };
  });
}

/* ---- QC ITEM_SET ------------------------------------------------ */

export type SetHandymanQcRunItemOutcomeInput = {
  qcRunId: string;
  itemKey: string;
  outcome: HandymanQcItemOutcome;
  note?: string | null;
  idempotencyKey: string;
};

export type HandymanQcItemSetResult = {
  item: HandymanQcRunItemRecord;
  event: HandymanQcRunEventRecord;
  replayed: boolean;
};

/**
 * ITEM_SET (D3): sets the outcome of one checklist item on an OPEN
 * run — terminal runs take no item writes (bounded 409). The item
 * row upserts (run,item_key); the EVENT log is append-only, so the
 * full set-history survives. Replay of the same key replays the
 * SAME event.
 */
export async function setHandymanQcRunItemOutcome(
  input: SetHandymanQcRunItemOutcomeInput,
  actorUserId: string,
): Promise<HandymanQcItemSetResult> {
  const runUuid = ensureUuid(input.qcRunId, 'qcRunId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const itemKey = ensureItemKey(input.itemKey);
  const outcome = ensureOutcome(input.outcome);
  const note = input.note === undefined ? null : input.note;
  if (note !== null && typeof note !== 'string') {
    throw handymanEvidenceValidationError('note');
  }

  return withTransaction(async (tx: PoolClient) => {
    const run = await handymanEvidenceQcRepository
      .findQcRunByIdForUpdate(tx, runUuid);
    if (!run) throw handymanQcRunNotFoundError();
    await qcAuthorityPreamble(run.executionScopeId, actorUuid);

    // Replay before the transition check (same key replays).
    const replayEvent = await handymanEvidenceQcRepository
      .findQcRunEventByIdempotency(tx, runUuid, 'ITEM_SET', key);
    if (replayEvent) {
      const items = await handymanEvidenceQcRepository
        .listQcRunItems(tx, runUuid);
      const item = items.find((candidate) =>
        candidate.itemKey === itemKey) ?? null;
      if (!item) throw handymanQcIdempotencyConflictError();
      return { item, event: replayEvent, replayed: true };
    }

    if (run.status !== 'OPEN') {
      throw handymanQcRunIllegalTransitionError();
    }

    const item = await handymanEvidenceQcRepository
      .setQcRunItemOutcome(tx, { runId: runUuid, itemKey, outcome,
        note });
    const event = await handymanEvidenceQcRepository
      .appendQcRunEvent(tx, {
        runId: runUuid,
        clientId: run.clientId,
        eventType: 'ITEM_SET',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { item, event, replayed: false };
  });
}

/* ---- QC FINISH -------------------------------------------------- */

export type FinishHandymanQcRunInput = {
  qcRunId: string;
  idempotencyKey: string;
};

export type HandymanQcFinishResult = {
  run: HandymanQcRunRecord;
  event: HandymanQcRunEventRecord;
  replayed: boolean;
};

/**
 * FINISH (D3): the terminal evaluation is computed SERVER-SIDE —
 * PASSED iff EVERY item outcome is PASS or NA; ANY DEFECT or
 * remaining NOT_CHECKED → FAILED. The caller never picks the
 * result. Terminal runs cannot be reopened: a fresh FINISH key on
 * a terminal run is a bounded 409; replay with the same key
 * returns the SAME event.
 */
export async function finishHandymanQcRun(
  input: FinishHandymanQcRunInput,
  actorUserId: string,
): Promise<HandymanQcFinishResult> {
  const runUuid = ensureUuid(input.qcRunId, 'qcRunId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  return withTransaction(async (tx: PoolClient) => {
    const run = await handymanEvidenceQcRepository
      .findQcRunByIdForUpdate(tx, runUuid);
    if (!run) throw handymanQcRunNotFoundError();
    await qcAuthorityPreamble(run.executionScopeId, actorUuid);

    const replayEvent = await handymanEvidenceQcRepository
      .findQcRunEventByIdempotency(tx, runUuid, 'FINISH', key);
    if (replayEvent) {
      return { run, event: replayEvent, replayed: true };
    }

    if (run.status !== 'OPEN') {
      throw handymanQcRunIllegalTransitionError();
    }

    // Server-evaluated terminal status (D3).
    const items = await handymanEvidenceQcRepository
      .listQcRunItems(tx, runUuid);
    const hasFailure = items.some((item) =>
      item.outcome === 'DEFECT' || item.outcome === 'NOT_CHECKED');
    const terminalStatus: HandymanQcRunStatus = hasFailure
      ? 'FAILED'
      : 'PASSED';

    const updated = await handymanEvidenceQcRepository
      .updateQcRunStatus(tx, runUuid, terminalStatus);
    if (!updated) throw handymanQcRunNotFoundError();
    const event = await handymanEvidenceQcRepository
      .appendQcRunEvent(tx, {
        runId: runUuid,
        clientId: run.clientId,
        eventType: 'FINISH',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { run: updated, event, replayed: false };
  });
}

/* ---- QC reads (Lead-gated projections) -------------------------- */

export type HandymanQcRunView = {
  run: HandymanQcRunRecord;
  items: HandymanQcRunItemRecord[];
};

/**
 * Per-scope QC run listing (run + items), Lead-gated, READ-ONLY
 * projections over committed state.
 */
export async function listHandymanQcRunsByScope(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanQcRunView[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await qcAuthorityPreamble(scopeUuid, actorUuid);
  const runs = await handymanEvidenceQcRepository
    .listQcRunsByScope(undefined, scopeUuid);
  const views = [] as HandymanQcRunView[];
  for (const run of runs) {
    const items = await handymanEvidenceQcRepository
      .listQcRunItems(undefined, run.id);
    views.push({ run, items });
  }
  return views;
}

export type HandymanQcRunDetailView = {
  run: HandymanQcRunRecord;
  items: HandymanQcRunItemRecord[];
  events: HandymanQcRunEventRecord[];
};

/** Single-run detail (run + items + append-only event chain). */
export async function getHandymanQcRunDetail(
  qcRunId: string,
  actorUserId: string,
): Promise<HandymanQcRunDetailView> {
  const runUuid = ensureUuid(qcRunId, 'qcRunId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const run = await handymanEvidenceQcRepository
    .findQcRunById(undefined, runUuid);
  if (!run) throw handymanQcRunNotFoundError();
  await qcAuthorityPreamble(run.executionScopeId, actorUuid);
  const items = await handymanEvidenceQcRepository
    .listQcRunItems(undefined, runUuid);
  const events = await handymanEvidenceQcRepository
    .listQcRunEvents(undefined, runUuid);
  return { run, items, events };
}

/* ==================================================================
 * CR-HM-10 PART 05 — DEFECT / RECTIFICATION / REINSPECTION commands
 * (governance PART 04): OPEN_DEFECT (optional run/item link,
 * provenance server-verified), START_RECTIFICATION,
 * RECORD_RECTIFICATION, REQUEST_REINSPECTION (loop),
 * PASS_REINSPECTION (terminal VERIFIED) + defect read models. ZERO
 * commercial coupling — defects NEVER adjust any settled amount.
 * NO API/OpenAPI here (later PART).
 * ================================================================== */

/**
 * Frozen status ladder (D3): OPENED → RECTIFYING → RECTIFIED →
 * VERIFIED; REINSPECTION loops RECTIFIED → RECTIFYING; VERIFIED is
 * locked. The FROM-set empty entries are open commands (creation).
 */
const DEFECT_TRANSITIONS: Record<Exclude<HandymanDefectEventType,
'OPEN_DEFECT'>, {
  from: readonly HandymanDefectStatus[];
  to: HandymanDefectStatus;
}> = {
  START_RECTIFICATION: { from: ['OPENED'], to: 'RECTIFYING' },
  RECORD_RECTIFICATION: { from: ['RECTIFYING'], to: 'RECTIFIED' },
  REQUEST_REINSPECTION: { from: ['RECTIFIED'], to: 'RECTIFYING' },
  PASS_REINSPECTION: { from: ['RECTIFIED'], to: 'VERIFIED' },
};

/**
 * Same preamble as PART 03/04 but 403 maps to the defect
 * vocabulary — identical authority chain, module-local error code.
 */
async function defectAuthorityPreamble(
  scopeUuid: string,
  actorUserId: string,
) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId,
    scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }
  const resolution = await resolveHandymanAssignmentLead(
    scopeUuid,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw handymanDefectNotAuthorizedError();
  }
  return { scope, resolution };
}

/**
 * Provenance link resolution (D3/D6): the optional run/item link
 * must resolve INSIDE this scope — a run from another scope is a
 * bounded 400; an item is resolved to its own run server-side
 * (callers never smuggle cross-scope or cross-run pairs; the DB
 * provenance trigger is the final wall).
 */
async function resolveDefectRunItemLink(
  scopeUuid: string,
  runId: string | null,
  itemId: string | null,
): Promise<{ runId: string | null; itemId: string | null }> {
  let resolvedRunId = runId;
  if (resolvedRunId !== null) {
    const run = await handymanEvidenceQcRepository
      .findQcRunById(undefined, resolvedRunId);
    if (!run || run.executionScopeId !== scopeUuid) {
      throw handymanEvidenceValidationError('runId');
    }
  }
  if (itemId === null) {
    return { runId: resolvedRunId, itemId: null };
  }
  const item = await handymanEvidenceQcRepository
    .findQcRunItemById(undefined, itemId);
  if (!item) throw handymanEvidenceValidationError('itemId');
  if (resolvedRunId !== null && item.runId !== resolvedRunId) {
    // Item must belong to the SAME run the caller linked; never
    // silently repoint the pair (DB provenance trigger backstop).
    throw handymanEvidenceValidationError('itemId');
  }
  if (resolvedRunId === null) {
    resolvedRunId = item.runId;
    const run = await handymanEvidenceQcRepository
      .findQcRunById(undefined, resolvedRunId);
    if (!run || run.executionScopeId !== scopeUuid) {
      throw handymanEvidenceValidationError('itemId');
    }
  }
  return { runId: resolvedRunId, itemId };
}

function ensureDefectDescription(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 4000) {
    throw handymanEvidenceValidationError('description');
  }
  return raw;
}

/* ---- OPEN_DEFECT ------------------------------------------------ */

export type OpenHandymanDefectInput = {
  executionScopeId: string;
  description: string;
  runId?: string | null;
  itemId?: string | null;
  idempotencyKey: string;
};

export type HandymanDefectCommandResult = {
  defect: HandymanDefectRecordRecord;
  event: HandymanDefectEventRecord;
  replayed: boolean;
};

/**
 * OPEN_DEFECT (D3): creates the defect head + OPEN_DEFECT event in
 * one atomic transaction (status OPENED server-side). Replay of
 * the same key + same link-shape returns the SAME rows; same key +
 * different shape is a bounded 409 idempotency conflict.
 */
export async function openHandymanDefect(
  input: OpenHandymanDefectInput,
  actorUserId: string,
): Promise<HandymanDefectCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const description = ensureDefectDescription(input.description);
  const runRaw = input.runId === undefined ? null : input.runId;
  const itemRaw = input.itemId === undefined ? null : input.itemId;
  const runExpl = runRaw === null ? null : ensureUuid(runRaw, 'runId');
  const itemExpl = itemRaw === null ? null
    : ensureUuid(itemRaw, 'itemId');
  const { scope } = await defectAuthorityPreamble(scopeUuid,
    actorUuid);
  const link = await resolveDefectRunItemLink(scopeUuid, runExpl,
    itemExpl);

  return withTransaction(async (tx: PoolClient) => {
    const replay = await handymanEvidenceQcRepository
      .findDefectOpenReplayByScope(tx, scopeUuid, key);
    if (replay) {
      if ((replay.defect.runId ?? null) !== link.runId
          || (replay.defect.itemId ?? null) !== link.itemId
          || replay.defect.description !== description) {
        throw handymanDefectIdempotencyConflictError();
      }
      return { defect: replay.defect, event: replay.event,
        replayed: true };
    }
    const defect = await handymanEvidenceQcRepository
      .createDefectRecord(tx, {
        clientId: scope.clientId,
        executionScopeId: scopeUuid,
        runId: link.runId,
        itemId: link.itemId,
        description,
      });
    const event = await handymanEvidenceQcRepository
      .appendDefectEvent(tx, {
        defectId: defect.id,
        clientId: scope.clientId,
        eventType: 'OPEN_DEFECT',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { defect, event, replayed: false };
  });
}

/* ---- ladder transitions ----------------------------------------- */

export type TransitionHandymanDefectInput = {
  defectId: string;
  idempotencyKey: string;
};

/**
 * Shared ladder executor (D3/D7): row-lock → replay-check →
 * stable-state check (frozen FROM set) → head status write → event
 * append — one transaction. VERIFIED is locked: every post-VERIFIED
 * mutation key is a bounded 409.
 */
async function transitionHandymanDefect(
  input: TransitionHandymanDefectInput,
  actorUserId: string,
  eventType: Exclude<HandymanDefectEventType, 'OPEN_DEFECT'>,
): Promise<HandymanDefectCommandResult> {
  const defectUuid = ensureUuid(input.defectId, 'defectId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  return withTransaction(async (tx: PoolClient) => {
    const defect = await handymanEvidenceQcRepository
      .findDefectByIdForUpdate(tx, defectUuid);
    if (!defect) throw handymanDefectNotFoundError();
    await defectAuthorityPreamble(defect.executionScopeId, actorUuid);

    const replayEvent = await handymanEvidenceQcRepository
      .findDefectEventByIdempotency(tx, defectUuid, eventType, key);
    if (replayEvent) {
      return { defect, event: replayEvent, replayed: true };
    }

    const rule = DEFECT_TRANSITIONS[eventType];
    if (!rule.from.includes(defect.status)) {
      throw handymanDefectIllegalTransitionError(defect.status,
        eventType);
    }
    const updated = await handymanEvidenceQcRepository
      .updateDefectStatus(tx, defectUuid, rule.to);
    if (!updated) throw handymanDefectNotFoundError();
    const event = await handymanEvidenceQcRepository
      .appendDefectEvent(tx, {
        defectId: defectUuid,
        clientId: defect.clientId,
        eventType,
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { defect: updated, event, replayed: false };
  });
}

/** START_RECTIFICATION: OPENED → RECTIFYING. */
export async function startHandymanDefectRectification(
  input: TransitionHandymanDefectInput,
  actorUserId: string,
): Promise<HandymanDefectCommandResult> {
  return transitionHandymanDefect(input, actorUserId,
    'START_RECTIFICATION');
}

/** RECORD_RECTIFICATION: RECTIFYING → RECTIFIED. */
export async function recordHandymanDefectRectification(
  input: TransitionHandymanDefectInput,
  actorUserId: string,
): Promise<HandymanDefectCommandResult> {
  return transitionHandymanDefect(input, actorUserId,
    'RECORD_RECTIFICATION');
}

/** REQUEST_REINSPECTION (loop): RECTIFIED → RECTIFYING. */
export async function requestHandymanDefectReinspection(
  input: TransitionHandymanDefectInput,
  actorUserId: string,
): Promise<HandymanDefectCommandResult> {
  return transitionHandymanDefect(input, actorUserId,
    'REQUEST_REINSPECTION');
}

/** PASS_REINSPECTION (terminal): RECTIFIED → VERIFIED (locked). */
export async function passHandymanDefectReinspection(
  input: TransitionHandymanDefectInput,
  actorUserId: string,
): Promise<HandymanDefectCommandResult> {
  return transitionHandymanDefect(input, actorUserId,
    'PASS_REINSPECTION');
}

/* ---- defect reads (Lead-gated projections) ----------------------- */

export type HandymanDefectDetailView = {
  defect: HandymanDefectRecordRecord;
  events: HandymanDefectEventRecord[];
};

/** Per-scope defect listing (current status snapshot), Lead-gated. */
export async function listHandymanDefectsByScope(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanDefectRecordRecord[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await defectAuthorityPreamble(scopeUuid, actorUuid);
  return handymanEvidenceQcRepository
    .listDefectsByScope(undefined, scopeUuid);
}

/** Single-defect detail (head + append-only event chain). */
export async function getHandymanDefectDetail(
  defectId: string,
  actorUserId: string,
): Promise<HandymanDefectDetailView> {
  const defectUuid = ensureUuid(defectId, 'defectId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const defect = await handymanEvidenceQcRepository
    .findDefectById(undefined, defectUuid);
  if (!defect) throw handymanDefectNotFoundError();
  await defectAuthorityPreamble(defect.executionScopeId, actorUuid);
  const events = await handymanEvidenceQcRepository
    .listDefectEvents(undefined, defectUuid);
  return { defect, events };
}
