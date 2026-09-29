import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  addHandymanEvidenceFile,
  createHandymanEvidenceRecord,
  finalizeHandymanEvidenceRecord,
  finishHandymanQcRun,
  getHandymanDefectDetail,
  getHandymanEvidenceRecordDetail,
  getHandymanQcRunDetail,
  listHandymanDefectsByScope,
  listHandymanEvidenceRecordsByScope,
  listHandymanQcRunsByScope,
  openHandymanDefect,
  openHandymanQcRun,
  passHandymanDefectReinspection,
  recordHandymanDefectRectification,
  requestHandymanDefectReinspection,
  setHandymanQcRunItemOutcome,
  startHandymanDefectRectification,
} from '../handyman-evidence-qc';
import type {
  HandymanDefectCommandResult,
  HandymanDefectEventRecord,
  HandymanDefectRecordRecord,
  HandymanEvidenceCommandResult,
  HandymanEvidenceEventRecord,
  HandymanEvidenceFileAddResult,
  HandymanEvidenceFileRecord,
  HandymanEvidenceRecordRecord,
  HandymanQcFinishResult,
  HandymanQcItemSetResult,
  HandymanQcOpenResult,
  HandymanQcRunEventRecord,
  HandymanQcRunItemRecord,
  HandymanQcRunRecord,
} from '../handyman-evidence-qc';
import {
  parseDefectIdParam,
  parseDefectOpenBody,
  parseEvidenceCreateBody,
  parseEvidenceFileAddBody,
  parseEvidenceRecordIdParam,
  parseKeyedBody,
  parseQcItemSetBody,
  parseQcOpenBody,
  parseQcRunIdParam,
  parseScopeParam,
} from './handyman-evidence-qc-api.validation';

/**
 * CR-HM-10 PART 06 — evidence/QC/defect HTTP handlers (THIN shell).
 * Each handler does EXACTLY: auth/context → bounded whitelist
 * validation → matching PART 03–05 service → bounded serialization.
 * ZERO lifecycle/outcome/transition logic here — the service layer
 * remains the SOLE authority. ZERO financial/ownership surface —
 * storage keys NEVER leave the persistence boundary (the engine's
 * managed-key discipline is validated inbound and echoed for the
 * file's own key ONLY at append time, never on reads).
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

/* ---- Bounded serializers (NO client id / actor id leakage) ------ */

function toEvidenceRecordPayload(record: HandymanEvidenceRecordRecord) {
  return {
    id: record.id,
    executionScopeId: record.executionScopeId,
    sessionId: record.sessionId,
    stage: record.stage,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toEvidenceFilePayload(file: HandymanEvidenceFileRecord,
  includeStorageKey = false) {
  return {
    id: file.id,
    recordId: file.recordId,
    mediaKind: file.mediaKind,
    ...(includeStorageKey ? { storageKey: file.storageKey } : {}),
    contentType: file.contentType,
    byteSize: file.byteSize,
    sha256Digest: file.sha256Digest,
    captureTime: file.captureTime,
    createdAt: file.createdAt,
  };
}

function toEvidenceEventPayload(event: HandymanEvidenceEventRecord) {
  return {
    id: event.id,
    recordId: event.recordId,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
  };
}

function toQcRunPayload(run: HandymanQcRunRecord) {
  return {
    id: run.id,
    executionScopeId: run.executionScopeId,
    sessionId: run.sessionId,
    checklistIdentity: run.checklistIdentity,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toQcRunItemPayload(item: HandymanQcRunItemRecord) {
  return {
    id: item.id,
    runId: item.runId,
    itemKey: item.itemKey,
    outcome: item.outcome,
    note: item.note,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toQcRunEventPayload(event: HandymanQcRunEventRecord) {
  return {
    id: event.id,
    runId: event.runId,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
  };
}

function toDefectPayload(defect: HandymanDefectRecordRecord) {
  return {
    id: defect.id,
    executionScopeId: defect.executionScopeId,
    runId: defect.runId,
    itemId: defect.itemId,
    description: defect.description,
    status: defect.status,
    createdAt: defect.createdAt,
    updatedAt: defect.updatedAt,
  };
}

function toDefectEventPayload(event: HandymanDefectEventRecord) {
  return {
    id: event.id,
    defectId: event.defectId,
    eventType: event.eventType,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
  };
}

/* ---- Evidence handlers ------------------------------------------ */

/** CREATE evidence record (PART 03 command). */
export async function postEvidenceCreateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseScopeParam(
      p(req.params.executionScopeId));
    const body = parseEvidenceCreateBody(req.body);
    const result: HandymanEvidenceCommandResult =
      await createHandymanEvidenceRecord({
        executionScopeId,
        stage: body.stage as never,
        description: body.description,
        sessionId: body.sessionId,
        idempotencyKey: body.idempotencyKey,
      }, actor(req));
    sendSuccess(res, {
      record: toEvidenceRecordPayload(result.record),
      event: toEvidenceEventPayload(result.event),
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** FILE_ADD (PART 03 command): bounded storage reference only. */
export async function postEvidenceFileAddHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const evidenceRecordId = parseEvidenceRecordIdParam(
      p(req.params.evidenceRecordId));
    const body = parseEvidenceFileAddBody(req.body);
    const result: HandymanEvidenceFileAddResult =
      await addHandymanEvidenceFile({
        evidenceRecordId,
        mediaKind: body.mediaKind as never,
        storageKey: body.storageKey,
        contentType: body.contentType,
        byteSize: body.byteSize,
        sha256Digest: body.sha256Digest,
        captureTime: body.captureTime,
        idempotencyKey: body.idempotencyKey,
      }, actor(req));
    sendSuccess(res, {
      file: toEvidenceFilePayload(result.file, true),
      event: toEvidenceEventPayload(result.event),
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** FINALIZE (PART 03 command): locks the file set. */
export async function postEvidenceFinalizeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const evidenceRecordId = parseEvidenceRecordIdParam(
      p(req.params.evidenceRecordId));
    const { idempotencyKey } = parseKeyedBody(req.body);
    const result: HandymanEvidenceCommandResult =
      await finalizeHandymanEvidenceRecord({
        evidenceRecordId,
        idempotencyKey,
      }, actor(req));
    sendSuccess(res, {
      record: toEvidenceRecordPayload(result.record),
      event: toEvidenceEventPayload(result.event),
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** Per-scope evidence listing (PART 03 read model). */
export async function getEvidenceByScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseScopeParam(
      p(req.params.executionScopeId));
    const views = await listHandymanEvidenceRecordsByScope(
      executionScopeId, actor(req));
    sendSuccess(res, {
      records: views.map((view) => ({
        record: toEvidenceRecordPayload(view.record),
        fileCount: view.fileCount,
        finalized: view.finalized,
      })),
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** Single-record detail (PART 03 read model). */
export async function getEvidenceRecordHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const evidenceRecordId = parseEvidenceRecordIdParam(
      p(req.params.evidenceRecordId));
    const view = await getHandymanEvidenceRecordDetail(
      evidenceRecordId, actor(req));
    sendSuccess(res, {
      record: toEvidenceRecordPayload(view.record),
      files: view.files.map((file) => toEvidenceFilePayload(file)),
      events: view.events.map(toEvidenceEventPayload),
      finalized: view.finalized,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/* ---- QC handlers ------------------------------------------------- */

/** OPEN run (PART 04 command): ONE OPEN per scope. */
export async function postQcOpenHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseScopeParam(
      p(req.params.executionScopeId));
    const body = parseQcOpenBody(req.body);
    const result: HandymanQcOpenResult = await openHandymanQcRun({
      executionScopeId,
      checklistIdentity: body.checklistIdentity,
      sessionId: body.sessionId,
      idempotencyKey: body.idempotencyKey,
    }, actor(req));
    sendSuccess(res, {
      run: toQcRunPayload(result.run),
      event: toQcRunEventPayload(result.event),
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** ITEM_SET (PART 04 command). */
export async function postQcItemSetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const qcRunId = parseQcRunIdParam(p(req.params.qcRunId));
    const body = parseQcItemSetBody(req.body);
    const result: HandymanQcItemSetResult =
      await setHandymanQcRunItemOutcome({
        qcRunId,
        itemKey: body.itemKey,
        outcome: body.outcome as never,
        note: body.note,
        idempotencyKey: body.idempotencyKey,
      }, actor(req));
    sendSuccess(res, {
      item: toQcRunItemPayload(result.item),
      event: toQcRunEventPayload(result.event),
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** FINISH (PART 04 command): server-side PASSED/FAILED decision. */
export async function postQcFinishHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const qcRunId = parseQcRunIdParam(p(req.params.qcRunId));
    const { idempotencyKey } = parseKeyedBody(req.body);
    const result: HandymanQcFinishResult = await finishHandymanQcRun({
      qcRunId,
      idempotencyKey,
    }, actor(req));
    sendSuccess(res, {
      run: toQcRunPayload(result.run),
      event: toQcRunEventPayload(result.event),
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** Per-scope QC run listing (PART 04 read model). */
export async function getQcRunsByScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseScopeParam(
      p(req.params.executionScopeId));
    const views = await listHandymanQcRunsByScope(executionScopeId,
      actor(req));
    sendSuccess(res, {
      runs: views.map((view) => ({
        run: toQcRunPayload(view.run),
        items: view.items.map(toQcRunItemPayload),
      })),
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** Single-run detail (PART 04 read model). */
export async function getQcRunHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const qcRunId = parseQcRunIdParam(p(req.params.qcRunId));
    const view = await getHandymanQcRunDetail(qcRunId, actor(req));
    sendSuccess(res, {
      run: toQcRunPayload(view.run),
      items: view.items.map(toQcRunItemPayload),
      events: view.events.map(toQcRunEventPayload),
    }, 200);
  } catch (error) {
    next(error);
  }
}

/* ---- Defect handlers ---------------------------------------------- */

/** OPEN_DEFECT (PART 05 command). */
export async function postDefectOpenHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseScopeParam(
      p(req.params.executionScopeId));
    const body = parseDefectOpenBody(req.body);
    const result: HandymanDefectCommandResult = await openHandymanDefect({
      executionScopeId,
      description: body.description,
      runId: body.runId,
      itemId: body.itemId,
      idempotencyKey: body.idempotencyKey,
    }, actor(req));
    sendSuccess(res, {
      defect: toDefectPayload(result.defect),
      event: toDefectEventPayload(result.event),
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** Shared thin ladder pipeline (PART 05 transitions). */
async function runDefectTransition(
  req: Request,
  res: Response,
  next: NextFunction,
  command: (
    input: { defectId: string; idempotencyKey: string },
    actorUserId: string,
  ) => Promise<HandymanDefectCommandResult>,
): Promise<void> {
  try {
    const defectId = parseDefectIdParam(p(req.params.defectId));
    const { idempotencyKey } = parseKeyedBody(req.body);
    const result = await command({ defectId, idempotencyKey },
      actor(req));
    sendSuccess(res, {
      defect: toDefectPayload(result.defect),
      event: toDefectEventPayload(result.event),
      replayed: result.replayed,
    }, 200);
  } catch (error) {
    next(error);
  }
}

/** START_RECTIFICATION (OPENED → RECTIFYING). */
export function postDefectStartRectificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runDefectTransition(req, res, next,
    startHandymanDefectRectification);
}

/** RECORD_RECTIFICATION (RECTIFYING → RECTIFIED). */
export function postDefectRecordRectificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runDefectTransition(req, res, next,
    recordHandymanDefectRectification);
}

/** REQUEST_REINSPECTION (RECTIFIED → RECTIFYING loop). */
export function postDefectRequestReinspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runDefectTransition(req, res, next,
    requestHandymanDefectReinspection);
}

/** PASS_REINSPECTION (RECTIFIED → VERIFIED, terminal). */
export function postDefectPassReinspectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runDefectTransition(req, res, next,
    passHandymanDefectReinspection);
}

/** Per-scope defect listing (PART 05 read model). */
export async function getDefectsByScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseScopeParam(
      p(req.params.executionScopeId));
    const defects = await listHandymanDefectsByScope(executionScopeId,
      actor(req));
    sendSuccess(res, { defects: defects.map(toDefectPayload) }, 200);
  } catch (error) {
    next(error);
  }
}

/** Single-defect detail (PART 05 read model). */
export async function getDefectHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const defectId = parseDefectIdParam(p(req.params.defectId));
    const view = await getHandymanDefectDetail(defectId, actor(req));
    sendSuccess(res, {
      defect: toDefectPayload(view.defect),
      events: view.events.map(toDefectEventPayload),
    }, 200);
  } catch (error) {
    next(error);
  }
}
