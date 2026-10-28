import { assertReworkQcBinding } from './handyman-rework-qc-binding';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type { AppError } from '../../shared/errors';
import { permissionService } from '../permissions';
import { recordOperationalEvent } from '../operational-events';
import { assertVerifiedManagedEvidenceReference }
  from '../handyman-field-evidence/handyman-field-evidence.service';
import {
  assertHandymanQcSupervisor,
  isHandymanQcSupervisor,
  lockHandymanQcScope,
} from './handyman-qc-authority';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess, canAccessClient,
  buildingAccessDeniedError } from '../context-access';
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
  handymanQcChecklistNotConfiguredError,
  handymanQcChecklistConflictError,
  handymanQcVersionConflictError,
  handymanQcStaleRunError,
  handymanQcPassBlockedError,
  handymanQcEvidenceInvalidError,
  handymanQcNotAuthorizedError,
  handymanQcRunAlreadyOpenError,
  handymanQcRunIllegalTransitionError,
  handymanQcRunNotFoundError,
  handymanDefectIdempotencyConflictError,
  handymanDefectIllegalTransitionError,
  handymanDefectVersionConflictError,
  handymanDefectRectificationRequiredError,
  handymanDefectEvidenceInvalidError,
  handymanDefectReinspectionRunRequiredError,
  handymanDefectNotAuthorizedError,
  handymanDefectNotFoundError,
} from './handyman-evidence-qc.errors';
import { handymanEvidenceQcRepository }
  from './handyman-evidence-qc.repository';
import type { HandymanQcChecklistSpec, HandymanQcChecklistVersion }
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
  HandymanQcRunEvidenceRecord,
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
 * CR-HM-SEC-01 PART 04E — shared authority preamble for the EVIDENCE
 * WRITE commands (create record, add file, finalize — its ONLY
 * callers after PART 04D moved the evidence reads to
 * `leadReadAuthorityPreamble`): scope exists (+404), CURRENT Crew
 * Lead resolution (403 *_NOT_AUTHORIZED; helper members
 * insufficient), and the data-scope wall is the BE-02G building
 * guard on the authoritative server-derived
 * `executionScope.buildingId` (migration 0395) — an explicit ACTIVE
 * `user_building_assignment` to the scope's exact Building under its
 * Client. The client-level `canAccessClient` wall is NOT sufficient
 * here — a same-Client sibling Building assignment must not open
 * the write.
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
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
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
  await leadReadAuthorityPreamble(scopeUuid, actorUuid,
    handymanEvidenceNotAuthorizedError);
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
  await leadReadAuthorityPreamble(record.executionScopeId, actorUuid,
    handymanEvidenceNotAuthorizedError);
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

/** QC decisions belong to the assigned, RBAC-granted Supervisor, never PIC. */
async function qcAuthorityPreamble(
  tx: PoolClient,
  scopeUuid: string,
  actorUserId: string,
) {
  const scope = await lockHandymanQcScope(tx, scopeUuid);
  await assertHandymanQcSupervisor(scope, actorUserId, tx);
  return scope;
}

/**
 * CR-HM-SEC-01 PART 04A + 04D — Lead READ authorization preamble
 * (scoped to the read models ONLY: the QC-run/defect reads and the
 * evidence-record reads; every WRITE keeps its own preamble —
 * `authorityPreamble` / `qcAuthorityPreamble` /
 * `defectAuthorityPreamble` — for its own PART). Same frozen worker
 * contract — scope exists, CURRENT authoritative Lead resolved via
 * the CR-HM-07 seam, actor IS that Lead, module-local error
 * vocabulary via `notAuthorized` — but the data-scope wall is the
 * BE-02G building guard on the authoritative server-derived
 * `executionScope.buildingId` (migration 0395): an explicit ACTIVE
 * `user_building_assignment` to the scope's exact Building under its
 * Client. The client-level `canAccessClient` wall is NOT sufficient
 * here — a same-Client sibling Building assignment must not open the
 * read.
 */
async function leadReadAuthorityPreamble(
  scopeUuid: string,
  actorUserId: string,
  notAuthorized: () => AppError,
) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  // CR-HM-SEC-01 PART 04A — explicit ACTIVE building assignment to
  // the scope's exact Building; otherwise 403 BUILDING_ACCESS_DENIED
  // (no same-Client shortcut, no existence/content leak).
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  const resolution = await resolveHandymanAssignmentLead(
    scopeUuid,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw notAuthorized();
  }
  return { scope, resolution };
}

/**
 * PIC sees the result of their work; the appointed Supervisor sees their
 * inspection; a staff reader needs tenant_company.read. None of those read
 * paths grants a QC mutation. Evidence file reads remain Lead-gated.
 */
async function qcDefectReadAuthorityPreamble(
  scopeUuid: string,
  actorUserId: string,
  notAuthorized: () => AppError,
): Promise<void> {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined, scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId, buildingId: scope.buildingId,
  });
  const permissions = await permissionService.resolvePermissionsForUser(
    actorUserId,
  );
  if (permissions.includes('tenant_company.read')) return;
  const lead = await resolveHandymanAssignmentLead(scopeUuid, actorUserId);
  if (lead?.leadUserId === actorUserId) return;
  const supervisor = await withTransaction(async (tx) => {
    await lockHandymanQcScope(tx, scopeUuid);
    return isHandymanQcSupervisor(scopeUuid, scope.clientId,
      actorUserId, tx);
  });
  if (!supervisor) throw notAuthorized();
}

/* ---- Required-item contract for the existing QC run ----------- */

export type PublishHandymanQcChecklistVersionInput = {
  clientId: string;
  code: string;
  versionNumber: number;
  requiredItemKeys: string[];
};

function validateRequiredQcKeys(value: string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw handymanEvidenceValidationError('requiredItemKeys');
  }
  const keys = value.map(ensureItemKey);
  if (new Set(keys).size !== keys.length) {
    throw handymanEvidenceValidationError('requiredItemKeys');
  }
  return keys;
}

async function assertQcConfigManager(actorId: string,
  clientId: string): Promise<void> {
  if (!(await canAccessClient(actorId, clientId))) {
    throw buildingAccessDeniedError();
  }
  const permissions = await permissionService.resolvePermissionsForUser(
    actorId);
  if (!permissions.includes('handyman.qc.configure')) {
    throw handymanQcNotAuthorizedError();
  }
}

/** Publish immutable, monotonically numbered Client-owned requirements.
 * This is configuration for the EXISTING QC run, not a parallel QC engine. */
export async function publishHandymanQcChecklistVersion(
  input: PublishHandymanQcChecklistVersionInput,
  actorUserId: string,
): Promise<{ version: HandymanQcChecklistVersion; replayed: boolean }> {
  const clientId = ensureUuid(input.clientId, 'clientId');
  const actorId = ensureUuid(actorUserId, 'actorUserId');
  const code = typeof input.code === 'string'
    ? input.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9._-]{0,127}$/.test(code)) {
    throw handymanEvidenceValidationError('code');
  }
  if (!Number.isInteger(input.versionNumber)
      || input.versionNumber < 1 || input.versionNumber > 1000000) {
    throw handymanEvidenceValidationError('versionNumber');
  }
  const keys = validateRequiredQcKeys(input.requiredItemKeys);
  await assertQcConfigManager(actorId, clientId);
  return withTransaction(async (tx) => {
    // Serialize two administrators publishing the next version for a Client.
    const client = await tx.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE',
      [clientId]);
    if (!client.rows[0]) throw buildingAccessDeniedError();
    const existing = await handymanEvidenceQcRepository
      .findQcChecklistVersionByCode(tx, clientId, code,
        input.versionNumber);
    if (existing) {
      if (existing.requiredItemKeys.length !== keys.length
          || existing.requiredItemKeys.some((item, index) =>
            item !== keys[index])) throw handymanQcChecklistConflictError();
      return { version: existing, replayed: true };
    }
    const latest = (await handymanEvidenceQcRepository
      .listQcChecklistVersions(tx, clientId))
      .find((v) => v.code === code);
    if (input.versionNumber !== (latest?.versionNumber ?? 0) + 1) {
      throw handymanQcChecklistConflictError();
    }
    const version = await handymanEvidenceQcRepository
      .publishQcChecklistVersion(tx, { clientId, code,
        versionNumber: input.versionNumber, requiredItemKeys: keys,
        publishedByUserId: actorId });
    await recordOperationalEvent({
      clientId, actorUserId: actorId, entityType: 'HANDYMAN_QC_CHECKLIST',
      entityId: version.id, eventType: 'HANDYMAN_QC_CHECKLIST_VERSION_PUBLISHED',
      summary: 'Published immutable Handyman QC checklist requirements.',
      metadata: { code, versionNumber: version.versionNumber,
        requiredItemKeys: keys },
    }, tx);
    return { version, replayed: false };
  });
}

export async function listHandymanQcChecklistVersions(
  clientIdRaw: string, actorUserId: string,
): Promise<HandymanQcChecklistVersion[]> {
  const clientId = ensureUuid(clientIdRaw, 'clientId');
  const actorId = ensureUuid(actorUserId, 'actorUserId');
  await assertQcConfigManager(actorId, clientId);
  return handymanEvidenceQcRepository.listQcChecklistVersions(undefined,
    clientId);
}

export type ConfigureHandymanQcChecklistInput = {
  executionScopeId: string;
  templateVersionId: string;
};

/** A scope pins one immutable published version before a NEW run opens.
 * Pre-version manifests are never silently backfilled or reinterpreted; an
 * administrator can explicitly bind a matching version between QC runs. */
export async function configureHandymanQcChecklist(
  input: ConfigureHandymanQcChecklistInput,
  actorUserId: string,
): Promise<{ spec: HandymanQcChecklistSpec; replayed: boolean }> {
  const scopeId = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorId = ensureUuid(actorUserId, 'actorUserId');
  const templateVersionId = ensureUuid(input.templateVersionId,
    'templateVersionId');
  return withTransaction(async (tx) => {
    const scope = await lockHandymanQcScope(tx, scopeId);
    await assertBuildingScopedResourceAccess(actorId, {
      clientId: scope.clientId, buildingId: scope.buildingId,
    });
    const permissions = await permissionService.resolvePermissionsForUser(
      actorId);
    if (!permissions.includes('handyman.qc.configure')) {
      throw handymanQcNotAuthorizedError();
    }
    if (scope.status !== 'AUTHORIZED') {
      throw handymanQcChecklistConflictError();
    }
    const version = await handymanEvidenceQcRepository
      .findQcChecklistVersionById(tx, templateVersionId);
    if (!version || version.clientId !== scope.clientId) {
      throw handymanQcChecklistConflictError();
    }
    const existing = await handymanEvidenceQcRepository.findQcChecklistSpec(
      tx, scopeId);
    if (existing?.templateVersionId === templateVersionId) {
      return { spec: existing, replayed: true };
    }
    if (existing?.templateVersionId
        || await handymanEvidenceQcRepository.findOpenQcRunByScope(tx,
          scopeId)) throw handymanQcChecklistConflictError();
    const latest = (await handymanEvidenceQcRepository
      .listQcChecklistVersions(tx, scope.clientId))
      .find((v) => v.code === version.code);
    if (!latest || latest.id !== version.id) {
      throw handymanQcChecklistConflictError();
    }
    const identity = `${version.code}@v${version.versionNumber}`;
    if (existing) {
      if (![identity, version.code.toLowerCase(), version.code]
        .includes(existing.checklistIdentity)
        || existing.requiredItemKeys.length
          !== version.requiredItemKeys.length
        || existing.requiredItemKeys.some((item, index) =>
          item !== version.requiredItemKeys[index])) {
        throw handymanQcChecklistConflictError();
      }
    } else {
      await handymanEvidenceQcRepository.createQcChecklistSpec(tx, {
        executionScopeId: scopeId, clientId: scope.clientId,
        checklistIdentity: identity,
        requiredItemKeys: version.requiredItemKeys,
        configuredByUserId: actorId,
      });
    }
    await handymanEvidenceQcRepository.bindQcChecklistVersion(tx, {
      executionScopeId: scopeId, checklistVersionId: version.id,
      boundByUserId: actorId,
    });
    const spec = await handymanEvidenceQcRepository.findQcChecklistSpec(
      tx, scopeId);
    if (!spec) throw handymanQcChecklistConflictError();
    await recordOperationalEvent({
      clientId: scope.clientId, buildingId: scope.buildingId,
      actorUserId: actorId, entityType: 'HANDYMAN_QC_CHECKLIST',
      entityId: scopeId, eventType: 'HANDYMAN_QC_CHECKLIST_CONFIGURED',
      summary: 'Pinned an immutable versioned QC checklist to the scope.',
      metadata: { templateVersionId, templateCode: version.code,
        templateVersionNumber: version.versionNumber,
        checklistIdentity: spec.checklistIdentity,
        requiredItemKeys: spec.requiredItemKeys },
    }, tx);
    return { spec, replayed: false };
  });
}

export async function getHandymanQcChecklist(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanQcChecklistSpec | null> {
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  const actorId = ensureUuid(actorUserId, 'actorUserId');
  await qcDefectReadAuthorityPreamble(scopeId, actorId,
    handymanQcNotAuthorizedError);
  return handymanEvidenceQcRepository.findQcChecklistSpec(undefined, scopeId);
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
  const boundSessionId = await ensureSessionBinding(sessionId,
    scopeUuid);

  return withTransaction(async (tx: PoolClient) => {
    const scope = await qcAuthorityPreamble(tx, scopeUuid, actorUuid);
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
    // ONE OPEN per scope; required keys come from the immutable,
    // coordinator-configured scope manifest, never from the QC caller.
    const openRun = await handymanEvidenceQcRepository
      .findOpenQcRunByScope(tx, scopeUuid);
    if (openRun) throw handymanQcRunAlreadyOpenError();
    const spec = await handymanEvidenceQcRepository.findQcChecklistSpec(
      tx, scopeUuid);
    if (scope.status !== 'AUTHORIZED' || !spec
        || spec.clientId !== scope.clientId
        || spec.checklistIdentity !== checklistIdentity
        || !spec.templateVersionId || !spec.boundAt
        || spec.requiredItemKeys.length === 0) {
      throw handymanQcChecklistNotConfiguredError();
    }
    const reworkReady = (await tx.query<{ready:boolean}>(`SELECT EXISTS (
      SELECT 1 FROM handyman_warranty_rework_completions c
      JOIN handyman_service_warranty_reworks r ON r.id=c.rework_id AND r.status='REWORK_COMPLETE'
      WHERE c.execution_scope_id=x.execution_scope_id AND hm_warranty_rework_scope_current(x.execution_scope_id)) AS ready
      FROM handyman_warranty_rework_executions x WHERE x.execution_scope_id=$1`, [scopeUuid])).rows[0];
    if (reworkReady && !reworkReady.ready) throw handymanQcPassBlockedError('rework completion required before QC');
    const run = await handymanEvidenceQcRepository
      .createQcRun(tx, {
        clientId: scope.clientId,
        executionScopeId: scopeUuid,
        sessionId: boundSessionId,
        checklistIdentity,
      });
    await assertReworkQcBinding(tx,scopeUuid,run.id);
    for (const itemKey of spec.requiredItemKeys) {
      await handymanEvidenceQcRepository.setQcRunItemOutcome(tx, {
        runId: run.id, itemKey, outcome: 'NOT_CHECKED', note: null,
      });
    }
    const event = await handymanEvidenceQcRepository
      .appendQcRunEvent(tx, {
        runId: run.id,
        clientId: scope.clientId,
        eventType: 'OPEN',
        idempotencyKey: key,
        actorUserId: actorUuid,
        metadata: { checklistIdentity, templateVersionId: spec.templateVersionId,
          templateCode: spec.templateCode,
          templateVersionNumber: spec.templateVersionNumber,
          requiredItemKeys: spec.requiredItemKeys },
      });
    await recordOperationalEvent({
      clientId: scope.clientId, buildingId: scope.buildingId,
      actorUserId: actorUuid, entityType: 'HANDYMAN_QC_RUN',
      entityId: run.id, eventType: 'HANDYMAN_QC_RUN_OPENED',
      summary: 'Supervisor opened a Handyman QC run.',
      metadata: { executionScopeId: scopeUuid, checklistIdentity },
    }, tx);
    return { run, event, replayed: false };
  });
}

/* ---- QC ITEM_SET ------------------------------------------------ */

export type SetHandymanQcRunItemOutcomeInput = {
  qcRunId: string;
  itemKey: string;
  outcome: HandymanQcItemOutcome;
  note?: string | null;
  expectedVersion?: number;
  idempotencyKey: string;
};

export type HandymanQcItemSetResult = {
  item: HandymanQcRunItemRecord;
  event: HandymanQcRunEventRecord;
  runVersion: number;
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
  if (input.expectedVersion !== undefined
      && (!Number.isInteger(input.expectedVersion)
        || input.expectedVersion < 1)) {
    throw handymanEvidenceValidationError('expectedVersion');
  }

  const target = await handymanEvidenceQcRepository.findQcRunById(
    undefined, runUuid,
  );
  if (!target) throw handymanQcRunNotFoundError();
  return withTransaction(async (tx: PoolClient) => {
    await qcAuthorityPreamble(tx, target.executionScopeId, actorUuid);
    const run = await handymanEvidenceQcRepository
      .findQcRunByIdForUpdate(tx, runUuid);
    if (!run) throw handymanQcRunNotFoundError();

    // Replay before the transition check (same key replays).
    const replayEvent = await handymanEvidenceQcRepository
      .findQcRunEventByIdempotency(tx, runUuid, 'ITEM_SET', key);
    if (replayEvent) {
      const items = await handymanEvidenceQcRepository
        .listQcRunItems(tx, runUuid);
      const item = items.find((candidate) =>
        candidate.itemKey === itemKey) ?? null;
      if (!item || (replayEvent.metadata.itemKey
          && (replayEvent.metadata.itemKey !== itemKey
            || replayEvent.metadata.outcome !== outcome
            || (replayEvent.metadata.note ?? null) !== note))) {
        throw handymanQcIdempotencyConflictError();
      }
      return { item, event: replayEvent, runVersion: run.version,
        replayed: true };
    }

    if (run.status !== 'OPEN') {
      throw handymanQcRunIllegalTransitionError();
    }
    if (input.expectedVersion !== undefined
        && run.version !== input.expectedVersion) {
      throw handymanQcVersionConflictError();
    }
    const spec = await handymanEvidenceQcRepository.findQcChecklistSpec(
      tx, run.executionScopeId);
    if (spec && !spec.requiredItemKeys.includes(itemKey)) {
      throw handymanEvidenceValidationError('itemKey');
    }
    const item = await handymanEvidenceQcRepository
      .setQcRunItemOutcome(tx, { runId: runUuid, itemKey, outcome,
        note });
    const updated = await handymanEvidenceQcRepository.bumpQcRunVersion(
      tx, runUuid, run.version);
    if (!updated) throw handymanQcVersionConflictError();
    const event = await handymanEvidenceQcRepository
      .appendQcRunEvent(tx, {
        runId: runUuid,
        clientId: run.clientId,
        eventType: 'ITEM_SET',
        idempotencyKey: key,
        actorUserId: actorUuid,
        metadata: { itemKey, outcome, note },
      });
    return { item, event, runVersion: updated.version, replayed: false };
  });
}

/* ---- Verified evidence binding to the existing QC run --------- */

export type BindHandymanQcEvidenceInput = {
  qcRunId: string;
  evidenceReference: string;
  expectedVersion: number;
  idempotencyKey: string;
};

export async function bindHandymanQcEvidence(
  input: BindHandymanQcEvidenceInput,
  actorUserId: string,
): Promise<{ evidence: HandymanQcRunEvidenceRecord;
  runVersion: number; replayed: boolean }> {
  const runId = ensureUuid(input.qcRunId, 'qcRunId');
  const actorId = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const reference = typeof input.evidenceReference === 'string'
    ? input.evidenceReference.trim() : '';
  if (!/^hm-ev:\/\/[0-9a-f-]{36}$/i.test(reference)) {
    throw handymanEvidenceValidationError('evidenceReference');
  }
  if (!Number.isInteger(input.expectedVersion)
      || input.expectedVersion < 1) {
    throw handymanEvidenceValidationError('expectedVersion');
  }
  const target = await handymanEvidenceQcRepository.findQcRunById(
    undefined, runId);
  if (!target) throw handymanQcRunNotFoundError();
  return withTransaction(async (tx) => {
    const scope = await qcAuthorityPreamble(tx,
      target.executionScopeId, actorId);
    const run = await handymanEvidenceQcRepository.findQcRunByIdForUpdate(
      tx, runId);
    if (!run) throw handymanQcRunNotFoundError();
    const replay = await handymanEvidenceQcRepository.findQcEvidenceByKey(
      tx, runId, key);
    if (replay) {
      if (replay.evidenceReference !== reference) {
        throw handymanQcIdempotencyConflictError();
      }
      return { evidence: replay, runVersion: run.version, replayed: true };
    }
    if (run.status !== 'OPEN') throw handymanQcRunIllegalTransitionError();
    if (run.version !== input.expectedVersion) {
      throw handymanQcVersionConflictError();
    }
    const latest = await handymanEvidenceQcRepository.findLatestQcRunByScope(
      tx, run.executionScopeId);
    if (!latest || latest.id !== run.id) throw handymanQcStaleRunError();
    const fullScope = await handymanExecutionScopeRepository.findScopeById(
      tx, run.executionScopeId);
    if (!fullScope) throw handymanExecutionScopeNotFoundError();
    const upload = await tx.query<{
      id: string; purpose: string; upload_status: string;
      verified_at: Date | null;
    }>(
      `SELECT id, purpose, upload_status, verified_at
         FROM handyman_field_evidence_uploads
        WHERE attachment_reference = $1 AND execution_scope_id = $2
          AND client_id = $3 AND building_id = $4`,
      [reference, run.executionScopeId, scope.clientId, scope.buildingId],
    );
    const row = upload.rows[0];
    if (!row || row.purpose !== 'QC_EVIDENCE'
        || row.upload_status !== 'VERIFIED' || !row.verified_at) {
      throw handymanQcEvidenceInvalidError();
    }
    const runs = await handymanEvidenceQcRepository.listQcRunsByScope(
      tx, run.executionScopeId);
    const previous = runs.filter((candidate) => candidate.id !== run.id)
      .at(-1);
    // The attachment must be captured for this adjudication, not recycled
    // from a prior run (or from work done before the run opened).
    if (row.verified_at.getTime() < new Date(run.createdAt).getTime()
        || (previous && row.verified_at.getTime()
          <= new Date(previous.updatedAt).getTime())) {
      throw handymanQcEvidenceInvalidError();
    }
    await assertVerifiedManagedEvidenceReference(tx, {
      clientId: scope.clientId, buildingId: scope.buildingId,
      handymanRequestId: fullScope.handymanRequestId,
      executionScopeId: run.executionScopeId,
    }, reference);
    const existing = await handymanEvidenceQcRepository.listQcRunEvidence(
      tx, runId);
    if (existing.some((evidence) => evidence.evidenceUploadId === row.id)) {
      throw handymanQcEvidenceInvalidError();
    }
    const evidence = await handymanEvidenceQcRepository.insertQcRunEvidence(
      tx, { runId, evidenceUploadId: row.id, actorUserId: actorId,
        idempotencyKey: key });
    const updated = await handymanEvidenceQcRepository.bumpQcRunVersion(
      tx, runId, run.version);
    if (!updated) throw handymanQcVersionConflictError();
    await recordOperationalEvent({
      clientId: scope.clientId, buildingId: scope.buildingId,
      actorUserId: actorId, entityType: 'HANDYMAN_QC_RUN',
      entityId: runId, eventType: 'HANDYMAN_QC_EVIDENCE_VERIFIED',
      summary: 'Supervisor bound a byte-verified QC evidence upload.',
      metadata: { executionScopeId: run.executionScopeId,
        evidenceUploadId: row.id },
    }, tx);
    return { evidence, runVersion: updated.version, replayed: false };
  });
}

/* ---- QC FINISH -------------------------------------------------- */

export type FinishHandymanQcRunInput = {
  qcRunId: string;
  /** Requested decision is an assertion, NOT the authority for a PASS. */
  outcome: 'PASSED' | 'FAILED';
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
};

export type HandymanQcFinishResult = {
  run: HandymanQcRunRecord;
  event: HandymanQcRunEventRecord;
  replayed: boolean;
};

/**
 * The client requests PASS/FAIL, but only the locked, current run and its
 * server-owned checklist/evidence/defect/session facts can authorize PASS.
 * FAIL records a reason without destroying failed items, evidence or defects.
 * The CAS head update, append-only FINISH event and operational audit event
 * commit in the same transaction. A retry with the same key never redecides.
 */
export async function finishHandymanQcRun(
  input: FinishHandymanQcRunInput,
  actorUserId: string,
): Promise<HandymanQcFinishResult> {
  const runUuid = ensureUuid(input.qcRunId, 'qcRunId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  if (input.outcome !== 'PASSED' && input.outcome !== 'FAILED') {
    throw handymanEvidenceValidationError('outcome');
  }
  if (!Number.isInteger(input.expectedVersion)
      || input.expectedVersion < 1) {
    throw handymanEvidenceValidationError('expectedVersion');
  }
  const reason = typeof input.reason === 'string'
    ? input.reason.trim() : null;
  if (input.outcome === 'FAILED'
      ? !reason || reason.length > 2000
      : reason !== null) {
    throw handymanEvidenceValidationError('reason');
  }

  const target = await handymanEvidenceQcRepository.findQcRunById(
    undefined, runUuid,
  );
  if (!target) throw handymanQcRunNotFoundError();
  return withTransaction(async (tx: PoolClient) => {
    const scope = await qcAuthorityPreamble(tx,
      target.executionScopeId, actorUuid);
    const run = await handymanEvidenceQcRepository
      .findQcRunByIdForUpdate(tx, runUuid);
    if (!run) throw handymanQcRunNotFoundError();

    const replayEvent = await handymanEvidenceQcRepository
      .findQcRunEventByIdempotency(tx, runUuid, 'FINISH', key);
    if (replayEvent) {
      if (replayEvent.metadata.outcome !== input.outcome
          || replayEvent.metadata.expectedVersion !== input.expectedVersion
          || (replayEvent.metadata.reason ?? null) !== reason) {
        throw handymanQcIdempotencyConflictError();
      }
      return { run, event: replayEvent, replayed: true };
    }
    const latest = await handymanEvidenceQcRepository.findLatestQcRunByScope(
      tx, run.executionScopeId);
    if (!latest || latest.id !== run.id) throw handymanQcStaleRunError();
    if (run.status !== 'OPEN') throw handymanQcRunIllegalTransitionError();
    if (run.version !== input.expectedVersion) {
      throw handymanQcVersionConflictError();
    }
    if (scope.status !== 'AUTHORIZED') {
      throw handymanQcPassBlockedError('execution scope not authorized');
    }

    const spec = await handymanEvidenceQcRepository.findQcChecklistSpec(
      tx, run.executionScopeId);
    await assertReworkQcBinding(tx,run.executionScopeId,run.id);
    if (input.outcome === 'PASSED') {
      if (!spec || spec.clientId !== run.clientId
          || spec.checklistIdentity !== run.checklistIdentity
          || !spec.templateVersionId || !spec.boundAt
          || spec.requiredItemKeys.length === 0
          || new Date(run.createdAt) < new Date(spec.configuredAt)
          || new Date(run.createdAt) < new Date(spec.boundAt)) {
        throw handymanQcPassBlockedError('required checklist not bound to this run');
      }
      const items = await handymanEvidenceQcRepository.listQcRunItems(
        tx, runUuid);
      if (items.length !== spec.requiredItemKeys.length
          || spec.requiredItemKeys.some((key) =>
            items.find((item) => item.itemKey === key)?.outcome !== 'PASS')) {
        throw handymanQcPassBlockedError('required checklist incomplete or failed');
      }
      const defects = await handymanEvidenceQcRepository.listDefectsByScope(
        tx, run.executionScopeId);
      if (defects.some((defect) => defect.status !== 'VERIFIED')) {
        throw handymanQcPassBlockedError('unverified defects on execution scope');
      }
      const sessions = await tx.query<{
        id: string; status: string; completed_at: Date | null;
      }>(
        `SELECT id, status, completed_at FROM handyman_work_sessions
          WHERE execution_scope_id = $1 AND client_id = $2
          FOR SHARE`,
        [run.executionScopeId, run.clientId],
      );
      const isRework = (await tx.query<{scope_kind:string}>('SELECT scope_kind FROM handyman_execution_scopes WHERE id=$1',[run.executionScopeId])).rows[0]?.scope_kind==='WARRANTY_REWORK';
      if ((!isRework && sessions.rows.length === 0) || sessions.rows.some((session) =>
        !session.completed_at
          || !['COMPLETED', 'CHECKED_OUT'].includes(session.status))) {
        throw handymanQcPassBlockedError('Work Sessions not completed');
      }
      const runs = await handymanEvidenceQcRepository.listQcRunsByScope(
        tx, run.executionScopeId);
      const previous = runs.filter((candidate) => candidate.id !== run.id)
        .at(-1);
      if (previous?.status === 'FAILED' && !sessions.rows.some((session) =>
        session.completed_at
          && session.completed_at.getTime()
            > new Date(previous.updatedAt).getTime())) {
        throw handymanQcPassBlockedError('corrective Work Session not completed after QC FAIL');
      }
      const evidence = await handymanEvidenceQcRepository.listQcRunEvidence(
        tx, runUuid);
      if (evidence.length === 0) {
        throw handymanQcPassBlockedError('no byte-verified QC evidence bound to run');
      }
      const fullScope = await handymanExecutionScopeRepository.findScopeById(
        tx, run.executionScopeId);
      if (!fullScope) throw handymanExecutionScopeNotFoundError();
      for (const binding of evidence) {
        const verification = await tx.query<{
          purpose: string; verified_at: Date | null;
        }>(
          `SELECT purpose, verified_at FROM handyman_field_evidence_uploads
            WHERE id = $1 AND execution_scope_id = $2 AND client_id = $3
              AND building_id = $4 AND upload_status = 'VERIFIED'`,
          [binding.evidenceUploadId, run.executionScopeId, run.clientId,
            scope.buildingId],
        );
        const upload = verification.rows[0];
        if (!upload || upload.purpose !== 'QC_EVIDENCE'
            || !upload.verified_at
            || upload.verified_at.getTime()
              < new Date(run.createdAt).getTime()
            || (previous && upload.verified_at.getTime()
              <= new Date(previous.updatedAt).getTime())) {
          throw handymanQcPassBlockedError('QC evidence is unverified or stale');
        }
        await assertVerifiedManagedEvidenceReference(tx, {
          clientId: run.clientId, buildingId: scope.buildingId,
          handymanRequestId: fullScope.handymanRequestId,
          executionScopeId: run.executionScopeId,
        }, binding.evidenceReference);
      }
    }

    const updated = await handymanEvidenceQcRepository.updateQcRunStatus(
      tx, runUuid, input.outcome, input.expectedVersion, reason);
    if (!updated) throw handymanQcVersionConflictError();
    const event = await handymanEvidenceQcRepository.appendQcRunEvent(tx, {
      runId: runUuid, clientId: run.clientId, eventType: 'FINISH',
      idempotencyKey: key, actorUserId: actorUuid,
      metadata: { outcome: input.outcome, reason,
        expectedVersion: input.expectedVersion,
        templateVersionId: spec?.templateVersionId ?? null },
    });
    await recordOperationalEvent({
      clientId: run.clientId, buildingId: scope.buildingId,
      actorUserId: actorUuid, entityType: 'HANDYMAN_QC_RUN',
      entityId: runUuid, eventType: 'HANDYMAN_QC_RUN_FINISHED',
      summary: `Supervisor finished QC: ${input.outcome}.`,
      metadata: { executionScopeId: run.executionScopeId,
        outcome: input.outcome, reason, version: updated.version },
    }, tx);
    return { run: updated, event, replayed: false };
  });
}

/* ---- QC reads (Lead-gated projections) -------------------------- */

export type HandymanQcRunView = {
  run: HandymanQcRunRecord;
  items: HandymanQcRunItemRecord[];
  evidence: HandymanQcRunEvidenceRecord[];
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
  await qcDefectReadAuthorityPreamble(scopeUuid, actorUuid,
    handymanQcNotAuthorizedError);
  const runs = await handymanEvidenceQcRepository
    .listQcRunsByScope(undefined, scopeUuid);
  const views = [] as HandymanQcRunView[];
  for (const run of runs) {
    const items = await handymanEvidenceQcRepository
      .listQcRunItems(undefined, run.id);
    const evidence = await handymanEvidenceQcRepository
      .listQcRunEvidence(undefined, run.id);
    views.push({ run, items, evidence });
  }
  return views;
}

export type HandymanQcRunDetailView = {
  run: HandymanQcRunRecord;
  items: HandymanQcRunItemRecord[];
  events: HandymanQcRunEventRecord[];
  evidence: HandymanQcRunEvidenceRecord[];
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
  await qcDefectReadAuthorityPreamble(run.executionScopeId, actorUuid,
    handymanQcNotAuthorizedError);
  const items = await handymanEvidenceQcRepository
    .listQcRunItems(undefined, runUuid);
  const events = await handymanEvidenceQcRepository
    .listQcRunEvents(undefined, runUuid);
  const evidence = await handymanEvidenceQcRepository
    .listQcRunEvidence(undefined, runUuid);
  return { run, items, events, evidence };
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
 * QC/verification belongs to the Supervisor. Assigned PIC may only start
 * and report corrective work; no corrective command can verify its own work.
 */
async function defectAuthorityPreamble(
  tx: PoolClient,
  scopeUuid: string,
  actorUserId: string,
  role: 'SUPERVISOR' | 'PIC',
) {
  const scope = await lockHandymanQcScope(tx, scopeUuid);
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId, buildingId: scope.buildingId,
  });
  if (role === 'SUPERVISOR') {
    if (!(await isHandymanQcSupervisor(scopeUuid, scope.clientId,
      actorUserId, tx))) throw handymanDefectNotAuthorizedError();
  } else {
    const lead = await resolveHandymanAssignmentLead(scopeUuid,
      actorUserId);
    if (!lead || lead.leadUserId !== actorUserId) {
      throw handymanDefectNotAuthorizedError();
    }
  }
  return scope;
}

/**
 * Provenance link resolution (D3/D6): the optional run/item link
 * must resolve INSIDE this scope — a run from another scope is a
 * bounded 400; an item is resolved to its own run server-side
 * (callers never smuggle cross-scope or cross-run pairs; the DB
 * provenance trigger is the final wall).
 */
async function resolveDefectRunItemLink(
  tx: PoolClient,
  scopeUuid: string,
  runId: string | null,
  itemId: string | null,
): Promise<{ runId: string | null; itemId: string | null }> {
  let resolvedRunId = runId;
  if (resolvedRunId !== null) {
    const run = await handymanEvidenceQcRepository
      .findQcRunById(tx, resolvedRunId);
    if (!run || run.executionScopeId !== scopeUuid
        || run.status === 'PASSED') {
      throw handymanEvidenceValidationError('runId');
    }
  }
  if (itemId === null) {
    return { runId: resolvedRunId, itemId: null };
  }
  const item = await handymanEvidenceQcRepository
    .findQcRunItemById(tx, itemId);
  if (!item || item.outcome !== 'DEFECT') {
    throw handymanEvidenceValidationError('itemId');
  }
  if (resolvedRunId !== null && item.runId !== resolvedRunId) {
    // Item must belong to the SAME run the caller linked; never
    // silently repoint the pair (DB provenance trigger backstop).
    throw handymanEvidenceValidationError('itemId');
  }
  if (resolvedRunId === null) {
    resolvedRunId = item.runId;
    const run = await handymanEvidenceQcRepository
      .findQcRunById(tx, resolvedRunId);
    if (!run || run.executionScopeId !== scopeUuid
        || run.status === 'PASSED') {
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
  return withTransaction(async (tx: PoolClient) => {
    const scope = await defectAuthorityPreamble(tx, scopeUuid,
      actorUuid, 'SUPERVISOR');
    const replay = await handymanEvidenceQcRepository
      .findDefectOpenReplayByScope(tx, scopeUuid, key);
    if (replay) {
      if ((replay.defect.itemId ?? null) !== itemExpl
          || (runExpl !== null && replay.defect.runId !== runExpl)
          || (runExpl === null && itemExpl === null
            && replay.defect.runId !== null)
          || replay.defect.description !== description) {
        throw handymanDefectIdempotencyConflictError();
      }
      return { defect: replay.defect, event: replay.event,
        replayed: true };
    }
    const link = await resolveDefectRunItemLink(tx, scopeUuid, runExpl,
      itemExpl);
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
        metadata: { runId: link.runId, itemId: link.itemId },
      });
    await recordOperationalEvent({
      clientId: scope.clientId, buildingId: scope.buildingId,
      actorUserId: actorUuid, entityType: 'HANDYMAN_DEFECT',
      entityId: defect.id, eventType: 'HANDYMAN_DEFECT_OPENED',
      summary: 'Supervisor opened a defect for corrective work.',
      metadata: { executionScopeId: scopeUuid, runId: link.runId,
        itemId: link.itemId },
    }, tx);
    return { defect, event, replayed: false };
  });
}

/* ---- ladder transitions ----------------------------------------- */

export type TransitionHandymanDefectInput = {
  defectId: string;
  expectedVersion: number;
  idempotencyKey: string;
  /** RECORD only: completed Work Session of the current PIC. */
  sessionId?: string;
  /** RECORD only: verified BEFORE_AFTER_WORK attachment on this scope. */
  evidenceReference?: string;
  /** REQUEST_REINSPECTION only: Supervisor's rejection reason. */
  reason?: string;
};

/** Verify actual Work Session and managed bytes, never a claimed role/file. */
async function verifyDefectReworkProof(
  tx: PoolClient,
  defect: HandymanDefectRecordRecord,
  picUserId: string,
  sessionId: string,
  reference: string,
  recording: boolean,
): Promise<string> {
  const fullScope = await handymanExecutionScopeRepository.findScopeById(
    tx, defect.executionScopeId);
  if (!fullScope) throw handymanExecutionScopeNotFoundError();
  const sessions = await tx.query<{ completed_at: Date }>(
    `SELECT completed_at FROM handyman_work_sessions s
      WHERE s.id = $1 AND s.execution_scope_id = $2 AND s.client_id = $3
        AND s.lead_user_id = $4 AND s.status IN ('COMPLETED', 'CHECKED_OUT')
        AND s.completed_at IS NOT NULL
        AND ($5::boolean = false OR (
          s.assignment_id = (SELECT id
            FROM handyman_execution_scope_assignments
            WHERE execution_scope_id = $2 AND status = 'ACTIVE')
          AND s.completed_at > (SELECT updated_at
            FROM handyman_defect_records WHERE id = $6)))
      FOR SHARE OF s`,
    [sessionId, defect.executionScopeId, defect.clientId, picUserId,
      recording, defect.id],
  );
  const session = sessions.rows[0];
  if (!session) {
    throw handymanDefectRectificationRequiredError(
      'a completed corrective Work Session by the assigned PIC is required');
  }
  if (recording && defect.runId) {
    const linkedRun = await handymanEvidenceQcRepository.findQcRunById(
      tx, defect.runId);
    if (linkedRun?.status === 'FAILED' && session.completed_at.getTime()
        <= new Date(linkedRun.updatedAt).getTime()) {
      throw handymanDefectRectificationRequiredError(
        'corrective Work Session must finish after the linked QC failure');
    }
  }
  const uploads = await tx.query<{ id: string }>(
    `SELECT id FROM handyman_field_evidence_uploads
      WHERE attachment_reference = $1 AND purpose = 'BEFORE_AFTER_WORK'
        AND upload_status = 'VERIFIED' AND verified_at IS NOT NULL
        AND verified_at >= $2 AND execution_scope_id = $3
        AND client_id = $4 AND tenant_company_id = $5
        AND building_id = $6 AND handyman_request_id = $7
        AND uploaded_by_user_id = $8 AND uploaded_by_role = 'PIC_PEKERJAAN'`,
    [reference, session.completed_at, defect.executionScopeId,
      defect.clientId, fullScope.tenantCompanyId, fullScope.buildingId,
      fullScope.handymanRequestId, picUserId],
  );
  if (!uploads.rows[0]) throw handymanDefectEvidenceInvalidError();
  await assertVerifiedManagedEvidenceReference(tx, {
    clientId: defect.clientId, buildingId: fullScope.buildingId,
    handymanRequestId: fullScope.handymanRequestId,
    executionScopeId: defect.executionScopeId,
  }, reference);
  return uploads.rows[0].id;
}

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
  if (!Number.isInteger(input.expectedVersion)
      || input.expectedVersion < 1) {
    throw handymanEvidenceValidationError('expectedVersion');
  }
  const sessionId = eventType === 'RECORD_RECTIFICATION'
    ? ensureUuid(input.sessionId ?? '', 'sessionId') : null;
  const reference = eventType === 'RECORD_RECTIFICATION'
    ? input.evidenceReference?.trim() ?? '' : null;
  if (eventType === 'RECORD_RECTIFICATION'
      && !/^hm-ev:\/\/[0-9a-f-]{36}$/i.test(reference ?? '')) {
    throw handymanEvidenceValidationError('evidenceReference');
  }
  const reason = eventType === 'REQUEST_REINSPECTION'
    ? input.reason?.trim() ?? '' : null;
  if (eventType === 'REQUEST_REINSPECTION'
      && (!reason || reason.length > 2000)) {
    throw handymanEvidenceValidationError('reason');
  }

  const target = await handymanEvidenceQcRepository.findDefectById(
    undefined, defectUuid,
  );
  if (!target) throw handymanDefectNotFoundError();
  return withTransaction(async (tx: PoolClient) => {
    const scope = await defectAuthorityPreamble(tx,
      target.executionScopeId, actorUuid,
      eventType === 'START_RECTIFICATION'
        || eventType === 'RECORD_RECTIFICATION' ? 'PIC' : 'SUPERVISOR');
    const defect = await handymanEvidenceQcRepository
      .findDefectByIdForUpdate(tx, defectUuid);
    if (!defect) throw handymanDefectNotFoundError();

    const replayEvent = await handymanEvidenceQcRepository
      .findDefectEventByIdempotency(tx, defectUuid, eventType, key);
    if (replayEvent) {
      if (replayEvent.metadata.expectedVersion !== input.expectedVersion
          || (replayEvent.metadata.sessionId ?? null) !== sessionId
          || (replayEvent.metadata.evidenceReference ?? null) !== reference
          || (replayEvent.metadata.reason ?? null) !== reason) {
        throw handymanDefectIdempotencyConflictError();
      }
      return { defect, event: replayEvent, replayed: true };
    }
    const rule = DEFECT_TRANSITIONS[eventType];
    if (!rule.from.includes(defect.status)) {
      throw handymanDefectIllegalTransitionError(defect.status,
        eventType);
    }
    if (defect.version !== input.expectedVersion) {
      throw handymanDefectVersionConflictError();
    }
    let reinspectionRunId: string | null = null;
    if (eventType === 'REQUEST_REINSPECTION'
        || eventType === 'PASS_REINSPECTION') {
      const runs = await handymanEvidenceQcRepository.listQcRunsByScope(
        tx, defect.executionScopeId);
      const current = runs.at(-1);
      const preceding = runs.at(-2);
      // A new QC run, not the defect's original failing run or a frontend
      // claim, is the server-owned reinspection vehicle. A further repair
      // request needs its own failed FINISH (with reason) first; approval
      // occurs while the new run is OPEN, before its guarded PASS FINISH.
      if (!current || !preceding || preceding.status !== 'FAILED'
          || current.id === defect.runId
          || new Date(current.createdAt) < new Date(preceding.updatedAt)
          || (eventType === 'PASS_REINSPECTION'
            ? current.status !== 'OPEN'
            : current.status !== 'FAILED' || !current.failureReason)) {
        throw handymanDefectReinspectionRunRequiredError();
      }
      reinspectionRunId = current.id;
    }

    let proofSessionId: string | null = defect.rectificationSessionId;
    let proofUploadId: string | null = defect.rectificationEvidenceUploadId;
    if (eventType === 'START_RECTIFICATION'
        || eventType === 'REQUEST_REINSPECTION') {
      // Each failed reinspection starts a fresh repair cycle. The prior
      // proof survives in RECORD and REQUEST event metadata, not the head.
      proofSessionId = null;
      proofUploadId = null;
    } else if (eventType === 'RECORD_RECTIFICATION') {
      proofSessionId = sessionId;
      proofUploadId = await verifyDefectReworkProof(tx, defect, actorUuid,
        sessionId!, reference!, true);
    } else {
      const events = await handymanEvidenceQcRepository.listDefectEvents(
        tx, defectUuid);
      const recorded = events.filter((e) =>
        e.eventType === 'RECORD_RECTIFICATION').at(-1);
      if (!recorded || !proofSessionId || !proofUploadId
          || recorded.metadata.sessionId !== proofSessionId
          || recorded.metadata.evidenceUploadId !== proofUploadId) {
        throw handymanDefectRectificationRequiredError(
          'a recorded corrective session and evidence are required before reinspection');
      }
      await verifyDefectReworkProof(tx, defect, recorded.actorUserId,
        proofSessionId, `hm-ev://${proofUploadId}`, false);
    }
    const updated = await handymanEvidenceQcRepository.updateDefectStatus(
      tx, { defectId: defectUuid, from: defect.status, to: rule.to,
        expectedVersion: defect.version,
        rectificationSessionId: proofSessionId,
        rectificationEvidenceUploadId: proofUploadId });
    if (!updated) throw handymanDefectVersionConflictError();
    const event = await handymanEvidenceQcRepository.appendDefectEvent(tx, {
      defectId: defectUuid, clientId: defect.clientId, eventType,
      idempotencyKey: key, actorUserId: actorUuid,
      metadata: { expectedVersion: defect.version,
        resultingVersion: updated.version, sessionId,
        evidenceReference: reference, reason, reinspectionRunId,
        evidenceUploadId: eventType === 'RECORD_RECTIFICATION'
          ? proofUploadId : null,
        supersededSessionId: eventType === 'REQUEST_REINSPECTION'
          ? defect.rectificationSessionId : null,
        supersededEvidenceUploadId: eventType === 'REQUEST_REINSPECTION'
          ? defect.rectificationEvidenceUploadId : null },
    });
    await recordOperationalEvent({
      clientId: defect.clientId, buildingId: scope.buildingId,
      actorUserId: actorUuid, entityType: 'HANDYMAN_DEFECT',
      entityId: defectUuid, eventType: `HANDYMAN_DEFECT_${eventType}`,
      summary: `Defect ${eventType.toLowerCase().replace(/_/g, ' ')}.`,
      metadata: { executionScopeId: defect.executionScopeId,
        reason, reinspectionRunId, sessionId: proofSessionId,
        evidenceUploadId: proofUploadId, version: updated.version },
    }, tx);
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
  await qcDefectReadAuthorityPreamble(scopeUuid, actorUuid,
    handymanDefectNotAuthorizedError);
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
  await qcDefectReadAuthorityPreamble(defect.executionScopeId, actorUuid,
    handymanDefectNotAuthorizedError);
  const events = await handymanEvidenceQcRepository
    .listDefectEvents(undefined, defectUuid);
  return { defect, events };
}

/* ---- Customer Care read-only projections ------------------------- */

export type HandymanEvidenceFileReadProjection =
  Omit<HandymanEvidenceFileRecord, 'storageKey'>;

export type HandymanEvidenceCustomerCareDetailView = {
  record: HandymanEvidenceRecordRecord;
  files: HandymanEvidenceFileReadProjection[];
  events: HandymanEvidenceEventRecord[];
  finalized: boolean;
};

/**
 * CR-HM-SEC-01 PART 04D — Customer Care EVIDENCE READ preamble
 * (scoped to the evidence care views ONLY; the QC/defect care views
 * use `customerCareQcReadPreamble` from PART 04A). Same actor model
 * — a local Customer Care staff user (route: `tenant_company.read`),
 * never a Crew Lead; BM SSO / care-workspace principals carry no
 * userId and have no path to these projections — but the data-scope
 * wall is the BE-02G building guard on the scope's exact Building,
 * not the client-level `canAccessClient` shortcut.
 */
async function customerCareScopeReadPreamble(
  executionScopeId: string,
  actorUserId: string,
) {
  const scope = await handymanExecutionScopeRepository
    .findScopeById(undefined, executionScopeId);
  if (!scope) {
    throw handymanExecutionScopeNotFoundError();
  }
  // CR-HM-SEC-01 PART 04D — explicit ACTIVE building assignment to
  // the scope's exact Building; otherwise 403 BUILDING_ACCESS_DENIED
  // (no same-Client shortcut, no existence/content leak).
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  return scope;
}

/**
 * CR-HM-SEC-01 PART 04A — Customer Care QC/defect READ preamble
 * (scoped to the QC-run/defect care views ONLY; the evidence care
 * views keep `customerCareScopeReadPreamble` for their own PART).
 * Same actor model as `customerCareScopeReadPreamble` — a local
 * Customer Care staff user (route: `tenant_company.read`), never a
 * Crew Lead; BM SSO / care-workspace principals carry no userId and
 * have no path to these projections — but the data-scope wall is
 * the BE-02G building guard on the scope's exact Building, not the
 * client-level `canAccessClient` shortcut.
 */
async function customerCareQcReadPreamble(
  executionScopeId: string,
  actorUserId: string,
) {
  const scope = await handymanExecutionScopeRepository
    .findScopeById(undefined, executionScopeId);
  if (!scope) {
    throw handymanExecutionScopeNotFoundError();
  }
  // CR-HM-SEC-01 PART 04A — explicit ACTIVE building assignment to
  // the scope's exact Building; otherwise 403 BUILDING_ACCESS_DENIED
  // (no same-Client shortcut, no existence/content leak).
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  return scope;
}

export async function listHandymanEvidenceRecordsCustomerCareView(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanEvidenceRecordView[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await customerCareScopeReadPreamble(scopeUuid, actorUuid);
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

export async function getHandymanEvidenceRecordCustomerCareDetail(
  evidenceRecordId: string,
  actorUserId: string,
): Promise<HandymanEvidenceCustomerCareDetailView> {
  const recordUuid = ensureUuid(evidenceRecordId, 'evidenceRecordId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const record = await handymanEvidenceQcRepository
    .findEvidenceRecordById(undefined, recordUuid);
  if (!record) throw handymanEvidenceRecordNotFoundError();
  await customerCareScopeReadPreamble(record.executionScopeId, actorUuid);
  const rawFiles = await handymanEvidenceQcRepository
    .listEvidenceFilesByRecord(undefined, recordUuid);
  const files: HandymanEvidenceFileReadProjection[] = rawFiles.map(
    ({ storageKey: _storageKey, ...rest }) => rest,
  );
  const events = await handymanEvidenceQcRepository
    .listEvidenceEventsByRecord(undefined, recordUuid);
  const finalized = events.some((event) =>
    event.eventType === 'FINALIZE');
  return { record, files, events, finalized };
}

export async function listHandymanQcRunsCustomerCareView(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanQcRunView[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await customerCareQcReadPreamble(scopeUuid, actorUuid);
  const runs = await handymanEvidenceQcRepository
    .listQcRunsByScope(undefined, scopeUuid);
  const views = [] as HandymanQcRunView[];
  for (const run of runs) {
    const items = await handymanEvidenceQcRepository
      .listQcRunItems(undefined, run.id);
    const evidence = await handymanEvidenceQcRepository
      .listQcRunEvidence(undefined, run.id);
    views.push({ run, items, evidence });
  }
  return views;
}

export async function getHandymanQcRunCustomerCareDetail(
  qcRunId: string,
  actorUserId: string,
): Promise<HandymanQcRunDetailView> {
  const runUuid = ensureUuid(qcRunId, 'qcRunId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const run = await handymanEvidenceQcRepository
    .findQcRunById(undefined, runUuid);
  if (!run) throw handymanQcRunNotFoundError();
  await customerCareQcReadPreamble(run.executionScopeId, actorUuid);
  const items = await handymanEvidenceQcRepository
    .listQcRunItems(undefined, runUuid);
  const events = await handymanEvidenceQcRepository
    .listQcRunEvents(undefined, runUuid);
  const evidence = await handymanEvidenceQcRepository
    .listQcRunEvidence(undefined, runUuid);
  return { run, items, events, evidence };
}

export async function listHandymanDefectsCustomerCareView(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanDefectRecordRecord[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await customerCareQcReadPreamble(scopeUuid, actorUuid);
  return handymanEvidenceQcRepository
    .listDefectsByScope(undefined, scopeUuid);
}

export async function getHandymanDefectCustomerCareDetail(
  defectId: string,
  actorUserId: string,
): Promise<HandymanDefectDetailView> {
  const defectUuid = ensureUuid(defectId, 'defectId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const defect = await handymanEvidenceQcRepository
    .findDefectById(undefined, defectUuid);
  if (!defect) throw handymanDefectNotFoundError();
  await customerCareQcReadPreamble(defect.executionScopeId, actorUuid);
  const events = await handymanEvidenceQcRepository
    .listDefectEvents(undefined, defectUuid);
  return { defect, events };
}
