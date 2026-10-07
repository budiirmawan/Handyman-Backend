import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { MIME_BY_EVIDENCE_TYPE } from '../evidence/evidence-file.routes';
import {
  computeEvidenceSha256,
  EVIDENCE_HASH_ALGORITHM,
} from '../evidence/evidence-integrity';
import {
  createEvidenceStorage,
  evidenceStorageKey,
  isEvidenceStorageKey,
} from '../evidence/storage';
import { assertUtilityMeterReadingFieldActor } from '../mobile-utility-meter-reading/mobile-utility-meter-reading.field-authority';
import type { MobileUtilityMeterReadingFieldContext } from '../mobile-utility-meter-reading/mobile-utility-meter-reading.field-authority';
import { getMobileUtilityMeterReading } from '../mobile-utility-meter-reading/mobile-utility-meter-reading.service';
import { utilityMeterReadingRepository } from '../utility-meter-readings';
import { recordOperationalEvent } from '../operational-events';
import {
  utilityAbnormalConsumptionRepository,
  type UtilityAbnormalConsumptionRecord,
} from '../utility-abnormal-consumptions';
import { utilityMeterConsumptionRepository } from '../utility-meter-consumptions';
import { utilityMeterReadingNotFoundError } from '../utility-meter-readings';
import {
  listReadingEvidence,
  removeReadingEvidence,
  submitReadingEvidence,
  validateReadingEvidence,
  type PublicUtilityMeterReadingEvidence,
  type UtilityMeterReadingEvidenceReadiness,
} from '../utility-meter-reading-evidence';
import {
  utilityOcrCandidateNotFoundError,
  utilityOcrCandidateRepository,
  utilityOcrCandidateService,
  type PublicUtilityOcrCandidate,
  type UtilityOcrCandidateRecord,
} from '../utility-ocr-candidates';
import {
  MOBILE_READING_ABNORMAL_SIGNAL_LIMIT,
  MOBILE_READING_EVIDENCE_SUMMARY_LIMIT,
  MOBILE_READING_OCR_CANDIDATE_LIMIT,
  type MobileReadingAbnormalSignal,
  type MobileReadingAbnormalSignalProjection,
  type MobileReadingEvidenceItem,
  type MobileReadingEvidenceSummary,
  type MobileReadingEvidenceUploadInput,
  type MobileReadingOcrCandidateSuggestion,
  type MobileReadingOcrConfirmInput,
  type MobileReadingOcrDecisionResult,
  type MobileReadingOcrRejectInput,
  type MobileUtilityMeterReadingDetail,
} from './mobile-utility-meter-reading-verification.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — mobile field reading verification service.
 *
 * ONE RULE, APPLIED TO EVERY FUNCTION BELOW
 * -----------------------------------------
 * This module owns ADDRESSING, AUTHORITY and PROJECTION. It owns no evidence
 * engine, no OCR engine and no abnormality engine, because the repository already
 * has an authoritative owner for each:
 *
 *   reading evidence  → BE-18F `utility-meter-reading-evidence` (which itself is
 *                       the BE-07 engine bound to a reading: same
 *                       `evidence_requirements` / `evidence_submissions` tables,
 *                       same MIME rules, same 50 MB ceiling, same soft remove)
 *   file bytes + hash → the CR-BE-API-01 storage abstraction and
 *                       CR-BE-DOC-CONTROL-01 integrity, exactly as the BE-25E
 *                       mobile upload and `POST /evidence/:id/file` use them
 *   OCR candidates    → BE-18 `utility-ocr-candidates`, whose accept/reject
 *                       already own the advisory lock, the terminal-decision
 *                       guard, the value/Meter/Building agreement check and the
 *                       canonical UTILITY_OCR_CANDIDATE_ACCEPTED / _REJECTED
 *                       events
 *   abnormal signals  → BE-18G `utility_meter_consumptions` and BE-18J
 *                       `utility_abnormal_consumptions`, read through their own
 *                       repositories
 *
 * So every write here is a delegation, and every read here is a projection of
 * persisted rows. There is no second evidence table, no second upload path, no
 * threshold, no evaluator and no OCR.
 *
 * AUTHORITY IS NEVER THE PERMISSION ALONE
 * ---------------------------------------
 * `utility_meter.field.evidence` on the route says a role may do field evidence
 * work. It does NOT say this actor may do it on THIS reading. Every function
 * therefore starts from `assertUtilityMeterReadingFieldActor`, which resolves the
 * reading's uniquely-linked Reading Due and delegates to the PART 00 seam:
 * assignment to that due's generated task first, BE-02G Building access second.
 * A reading with no field due behind it — a management, engineering, import or
 * OCR-`readingAt` reading — is not field-accessible at all, and no weaker gate is
 * substituted for it.
 *
 * The `readingDueId` in the path is then re-checked against the due the seam
 * resolved, so PART 01's addressing invariant holds here too: the field identity
 * is the execution, and a mismatch is a 404 that never confirms the row exists.
 */

const storage = createEvidenceStorage();

/* -------------------------------------------------------------------------
 * Authority
 * ---------------------------------------------------------------------- */

/**
 * Resolves and authorizes the field reading this whole surface hangs off.
 *
 * Order matters and is pinned by tests: the reading is loaded and its field
 * authority proven BEFORE any evidence, candidate or signal row is touched, so
 * an unauthorized caller learns nothing about what exists.
 *
 * Exported for CR-BE-RN12-METER-FIELD-01 PART 03
 * (src/modules/mobile-utility-meter-reading-lifecycle/), whose recheck commands
 * hang off the same reading and must be authorized by the SAME rule in the SAME
 * order. One authority, one implementation: a copy here would be a second rule
 * that could drift from the one PART 02's routes are proven against.
 */
export async function authorizeFieldReading(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
): Promise<MobileUtilityMeterReadingFieldContext> {
  const context = await assertUtilityMeterReadingFieldActor(
    readingId,
    actorUserId,
  );
  // The path's execution identity must be the execution that produced this
  // reading. A mismatch is reported as 404, never 403 (PART 01 convention).
  if (context.due.id !== readingDueId) {
    throw utilityMeterReadingNotFoundError();
  }
  return context;
}

/* -------------------------------------------------------------------------
 * Evidence projections
 * ---------------------------------------------------------------------- */

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * BE-18F's evidence row → the MOBILE projection.
 *
 * The one deliberate difference from BE-18F's management shape is that
 * `fileReference` is not carried: the mobile evidence contract never exposes an
 * internal storage path (BE-25E). `uploadStatus` / `fileAvailable` are derived
 * from the stored key with the same `isEvidenceStorageKey` test the BE-25E
 * contract uses, so a client learns whether the bytes are retrievable without
 * learning where they live.
 */
function toMobileReadingEvidenceItem(
  evidence: PublicUtilityMeterReadingEvidence,
): MobileReadingEvidenceItem {
  const storageBacked = isEvidenceStorageKey(evidence.fileReference);
  return {
    id: evidence.id,
    meterReadingId: evidence.meterReadingId,
    evidenceRequirementId: evidence.evidenceRequirementId,
    evidenceType: evidence.evidenceType,
    originalFileName: evidence.originalFileName,
    mimeType: evidence.mimeType,
    fileSize: evidence.fileSize,
    capturedAt: evidence.capturedAt,
    uploadStatus: storageBacked ? 'UPLOADED' : 'PENDING',
    fileAvailable: storageBacked,
    submittedByUserId: evidence.submittedByUserId,
    status: evidence.status,
    createdAt: evidence.createdAt,
  };
}

/* -------------------------------------------------------------------------
 * Evidence — upload / list / readiness / remove
 * ---------------------------------------------------------------------- */

/** The uploaded bytes of a field evidence submission. */
export type MobileReadingEvidenceFile = {
  buffer: Buffer;
  mimeType: string;
  size: number;
  originalName: string;
};

/**
 * Field-safe single-call reading evidence upload.
 *
 * Composition, in order — each step an EXISTING authority:
 *
 *   1. `assertUtilityMeterReadingFieldActor` via `authorizeFieldReading`:
 *      assignment to the reading's generated task + Building access.
 *   2. MIME gate from the shared BE-07 `MIME_BY_EVIDENCE_TYPE` table, checked
 *      BEFORE any byte is written so a rejected type cannot leave an orphan
 *      blob. BE-18F re-checks the same table on its own write; checking it here
 *      too is ordering hygiene, not a second rule.
 *   3. The CR-BE-API-01 storage abstraction puts the bytes at a
 *      backend-generated key (`evidence/{uuid}`). No client-supplied path ever
 *      reaches storage, and file bytes never enter PostgreSQL.
 *   4. BE-18F `submitReadingEvidence` performs the AUTHORITATIVE metadata write:
 *      it resolves the reading's Client and Building, cross-checks the reading
 *      against its meter's Building, binds an `evidenceRequirementId` only when
 *      that requirement is ACTIVE, targets THIS reading, matches the evidence
 *      type and belongs to the same Client, enforces the requirement's maximum
 *      count, attaches retention governance and records
 *      `UTILITY_METER_READING_EVIDENCE_ADDED`. None of that is re-implemented
 *      here, and this is why the field door cannot become a cheaper write path
 *      than BE-18F's own.
 *   5. The CR-BE-DOC-CONTROL-01 integrity hash of the EXACT buffer handed to
 *      storage is persisted on the created row, with the canonical
 *      `EVIDENCE_INTEGRITY_HASH_RECORDED` event. This is the same step
 *      `POST /evidence/:evidenceId/file` performs when bytes are attached to an
 *      existing metadata row, and it is what keeps the invariant "evidence
 *      cannot gain a stored file without its integrity metadata" true for field
 *      photos too. No caller-supplied hash is accepted anywhere.
 *
 * The storage key is generated from an upload identity rather than from the row
 * id, because BE-18F owns id generation and its own contract takes the reference
 * as an input. `file_reference` is authoritative for every downstream consumer —
 * download, integrity verification and retention purge all read the stored
 * reference, never a key re-derived from the row id.
 *
 * NOT DONE HERE: no reading is created, updated, revalidated or gated. A
 * submission that leaves a requirement unsatisfied changes `evidenceValidation`
 * and nothing else — BE-18E readings stay append-only and a missing photo never
 * rejects a genuine reading.
 */
export async function submitMobileReadingEvidenceFile(input: {
  readingId: string;
  actorUserId: string;
  file: MobileReadingEvidenceFile;
  fields: MobileReadingEvidenceUploadInput;
  /**
   * Optional execution identity from the route path. When supplied it is
   * re-checked against the reading's own due, so the generic mobile evidence
   * door cannot be addressed with a due the reading does not belong to.
   */
  readingDueId?: string;
}): Promise<MobileReadingEvidenceItem> {
  const context = input.readingDueId
    ? await authorizeFieldReading(
        input.readingDueId,
        input.readingId,
        input.actorUserId,
      )
    : await assertUtilityMeterReadingFieldActor(
        input.readingId,
        input.actorUserId,
      );

  const allowedMime = MIME_BY_EVIDENCE_TYPE[input.fields.evidenceType] ?? [];
  if (!allowedMime.includes(input.file.mimeType)) {
    throw AppError.badRequest(
      `Evidence type ${input.fields.evidenceType} does not accept MIME type ${input.file.mimeType}.`,
    );
  }

  const uploadId = randomUUID();
  const key = evidenceStorageKey(uploadId);
  const contentSha256 = computeEvidenceSha256(input.file.buffer);
  await storage.put(key, {
    buffer: input.file.buffer,
    mimeType: input.file.mimeType,
  });

  const created = await submitReadingEvidence({
    meterReadingId: context.reading.id,
    evidenceType: input.fields.evidenceType,
    ...(input.fields.evidenceRequirementId === undefined
      ? {}
      : { evidenceRequirementId: input.fields.evidenceRequirementId }),
    fileReference: key,
    originalFileName:
      input.fields.originalFileName ?? input.file.originalName ?? '',
    mimeType: input.file.mimeType,
    fileSize: input.file.size,
    ...(input.fields.capturedAt === undefined
      ? {}
      : { capturedAt: input.fields.capturedAt }),
    submittedByUserId: input.actorUserId,
  });

  // Integrity metadata for the bytes this call stored (CR-BE-DOC-CONTROL-01
  // PART 01), persisted on the authoritative row BE-18F just created.
  await getPool().query(
    `UPDATE evidence_submissions
        SET content_sha256 = $2,
            content_hashed_at = NOW(),
            hash_algorithm = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [created.id, contentSha256, EVIDENCE_HASH_ALGORITHM],
  );
  await recordOperationalEvent({
    clientId: created.clientId,
    eventType: 'EVIDENCE_INTEGRITY_HASH_RECORDED',
    entityType: 'EVIDENCE_SUBMISSION',
    entityId: created.id,
    actorUserId: input.actorUserId,
    summary: 'Evidence integrity hash recorded',
    metadata: {
      evidenceId: created.id,
      algorithm: EVIDENCE_HASH_ALGORITHM,
      contentSha256,
      fileSize: input.file.size,
    },
  });

  return toMobileReadingEvidenceItem({
    ...created,
    // The row now carries its hash; the mobile projection does not expose
    // integrity fields, so nothing else changes.
  });
}

/**
 * The ACTIVE evidence of a field reading, through BE-18F's own list.
 *
 * BE-18F scopes this to the reading and re-asserts Building access; the field
 * seam has already proven strictly more. REMOVED rows are history and are not
 * returned here — the soft remove below is what puts them in that state, and
 * BE-18F's history read stays the management surface for it.
 */
export async function listMobileReadingEvidence(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
): Promise<MobileReadingEvidenceItem[]> {
  await authorizeFieldReading(readingDueId, readingId, actorUserId);
  const evidence = await listReadingEvidence(readingId, actorUserId);
  return evidence.map(toMobileReadingEvidenceItem);
}

/**
 * Canonical BE-18F evidence readiness of a field reading.
 *
 * Returned VERBATIM — `ready`, `missingEvidenceTypes` and the per-requirement
 * detail are BE-18F's, computed from the ACTIVE `evidence_requirements` rows
 * targeted at this reading and the ACTIVE submissions bound to them. No
 * requirement is synthesized: a reading with no persisted requirement is
 * `ready: true`, and this contract never asserts that a meter reading needs a
 * photo.
 *
 * Readiness is REPORTED, never enforced. It does not gate, reopen, invalidate or
 * delete the reading, and it is a separate statement from reading validity.
 */
export async function validateMobileReadingEvidence(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
): Promise<UtilityMeterReadingEvidenceReadiness> {
  await authorizeFieldReading(readingDueId, readingId, actorUserId);
  return validateReadingEvidence(readingId, actorUserId);
}

/**
 * Field-safe removal of one of THIS reading's evidence submissions.
 *
 * Removal is BE-07's soft `status → 'REMOVED'`, performed by BE-18F's own
 * service (which also records `UTILITY_METER_READING_EVIDENCE_REMOVED`). Nothing
 * is ever hard-deleted, so the evidence history survives, and the reading itself
 * is untouched: removing a photo can change `evidenceValidation.ready` to false
 * and changes nothing else.
 *
 * The parent check runs BEFORE the removal. BE-18F's remover resolves the
 * evidence's own reading and asserts Building access, which for a field actor is
 * not enough on its own: without this check an assigned technician could remove
 * evidence belonging to a different reading of a different meter in the same
 * Building. Ownership of the addressed reading is what this route grants, so
 * ownership of the addressed reading is what it enforces — and a foreign
 * evidence id is a 404 that never confirms the row exists.
 */
export async function removeMobileReadingEvidence(
  readingDueId: string,
  readingId: string,
  evidenceId: string,
  actorUserId: string,
): Promise<MobileReadingEvidenceItem> {
  await authorizeFieldReading(readingDueId, readingId, actorUserId);

  const existing = await getPool().query<{ execution_id: string }>(
    `SELECT execution_id FROM evidence_submissions
      WHERE id = $1 AND execution_type = 'UTILITY_METER_READING'`,
    [evidenceId],
  );
  const row = existing.rows[0];
  if (!row || row.execution_id !== readingId) {
    throw new AppError({
      code: ERROR_CODES.UTILITY_METER_READING_EVIDENCE_NOT_FOUND,
      message: 'Reading evidence not found.',
      statusCode: 404,
      resource: { type: 'UTILITY_METER_READING_EVIDENCE', id: evidenceId },
    });
  }

  const removed = await removeReadingEvidence(evidenceId, actorUserId);
  return toMobileReadingEvidenceItem(removed);
}

/**
 * The bounded evidence summary embedded in the reading DETAIL.
 *
 * `activeByType` always carries all three BE-07 types so a client can render
 * counts without a null check, and `truncated` says whether `items` is a prefix
 * of a longer ACTIVE set — the dedicated list route is where the rest is read.
 */
async function buildMobileReadingEvidenceSummary(
  readingId: string,
  actorUserId: string,
): Promise<MobileReadingEvidenceSummary> {
  const evidence = await listReadingEvidence(readingId, actorUserId);
  const items = evidence.map(toMobileReadingEvidenceItem);
  return {
    activeTotal: items.length,
    activeByType: {
      PHOTO: items.filter((item) => item.evidenceType === 'PHOTO').length,
      DOCUMENT: items.filter((item) => item.evidenceType === 'DOCUMENT').length,
      SIGNATURE: items.filter((item) => item.evidenceType === 'SIGNATURE').length,
    },
    truncated: items.length > MOBILE_READING_EVIDENCE_SUMMARY_LIMIT,
    items: items.slice(0, MOBILE_READING_EVIDENCE_SUMMARY_LIMIT),
  };
}

/* -------------------------------------------------------------------------
 * OCR — suggestions and the human decision on them
 * ---------------------------------------------------------------------- */

/**
 * BE-18 candidate row → the field SUGGESTION projection.
 *
 * Persisted columns only. No verdict, no recommendation, no comparison result:
 * the candidate value sits next to the reading the technician already recorded
 * and the human decides. `clientId` / `buildingId` / `meterId` are dropped
 * because the seam already pinned them to exactly one meter and Building.
 */
function toMobileOcrSuggestion(
  candidate: UtilityOcrCandidateRecord | PublicUtilityOcrCandidate,
): MobileReadingOcrCandidateSuggestion {
  return {
    id: candidate.id,
    evidenceId: candidate.evidenceId,
    candidateReadingValue: Number(candidate.candidateReadingValue),
    confidence:
      candidate.confidence === null || candidate.confidence === undefined
        ? null
        : Number(candidate.confidence),
    status: candidate.status,
    acceptedReadingId: candidate.acceptedReadingId,
    verifiedByUserId: candidate.verifiedByUserId,
    verifiedAt:
      candidate.verifiedAt instanceof Date
        ? candidate.verifiedAt.toISOString()
        : ((candidate.verifiedAt as string | null) ?? null),
    decisionNotes: candidate.decisionNotes,
    createdAt:
      candidate.createdAt instanceof Date
        ? candidate.createdAt.toISOString()
        : (candidate.createdAt as unknown as string),
  };
}

/**
 * The EXISTING OCR candidates staged from THIS reading's PHOTO evidence, as
 * suggestions.
 *
 * Scope is precise rather than generous: a candidate is returned only when its
 * own `evidence_id` is a BE-18F submission bound to this reading. Candidates
 * staged from another reading's evidence are not offered here even on the same
 * meter, because a suggestion is only meaningful against the reading its photo
 * depicts.
 *
 * NO CANDIDATE IS CREATED BY THIS CONTRACT, and no field route creates one.
 * Staging a candidate (`POST /utility/meter-reading-evidence/:evidenceId/ocr-candidates`)
 * stays a `utility_meter.manage` management act: it asserts a machine-readable
 * value and a confidence for a photo, which is an administrative judgement about
 * evidence quality, not something a technician standing at the meter should be
 * able to author for their own submission. There is no OCR or vision engine in
 * this repository and none is added — the value is human- or integration-staged,
 * and here it is only read.
 */
export async function listMobileReadingOcrCandidates(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
): Promise<MobileReadingOcrCandidateSuggestion[]> {
  await authorizeFieldReading(readingDueId, readingId, actorUserId);
  return buildOcrSuggestions(readingId);
}

async function buildOcrSuggestions(
  readingId: string,
): Promise<MobileReadingOcrCandidateSuggestion[]> {
  const candidates =
    await utilityOcrCandidateRepository.listByMeterReading(readingId);
  return candidates
    .slice(0, MOBILE_READING_OCR_CANDIDATE_LIMIT)
    .map(toMobileOcrSuggestion);
}

/**
 * Loads one candidate and proves it belongs to this field reading's context.
 *
 * Fail-closed and 404-on-mismatch: a candidate of another reading, another meter
 * or another Building is reported as not found, so this route can never be used
 * to decide a suggestion the actor has no business seeing, and never confirms
 * that one exists.
 */
async function authorizeOcrCandidateForReading(
  readingId: string,
  candidateId: string,
  context: MobileUtilityMeterReadingFieldContext,
): Promise<UtilityOcrCandidateRecord> {
  const candidate = await utilityOcrCandidateRepository.findById(candidateId);
  if (!candidate) throw utilityOcrCandidateNotFoundError();

  const scoped =
    await utilityOcrCandidateRepository.listByMeterReading(readingId);
  if (!scoped.some((row) => row.id === candidateId)) {
    throw utilityOcrCandidateNotFoundError();
  }
  if (
    candidate.meterId !== context.reading.meterId ||
    candidate.buildingId !== context.reading.buildingId ||
    candidate.clientId !== context.reading.clientId
  ) {
    throw utilityOcrCandidateNotFoundError();
  }
  return candidate;
}

/**
 * Field CONFIRM of an existing OCR suggestion against the reading the technician
 * already recorded.
 *
 * SUGGESTION ONLY, IN BOTH DIRECTIONS
 * -----------------------------------
 * Accepting a candidate does not make its value authoritative and does not write
 * it anywhere. The reading already exists — PART 01 created it, atomically, with
 * the due completed — and BE-18's acceptance merely records that a human judged
 * the staged suggestion to agree with it, by setting
 * `accepted_reading_id` to that reading. The reading's `reading_value` is never
 * updated by a confirmation, and a confirmation can never substitute a value for
 * the one the technician entered.
 *
 * DELEGATION, NOT REIMPLEMENTATION
 * --------------------------------
 * The decision goes through BE-18's own `acceptUtilityOcrCandidate`, so all of
 * its semantics are preserved exactly:
 *   - the per-candidate PostgreSQL advisory lock (`pg_advisory_lock` on the
 *     candidate id) that serializes concurrent decisions,
 *   - the PENDING_REVIEW precondition and the terminal-decision guard
 *     (`WHERE status = 'PENDING_REVIEW'`), so a second decision on the same
 *     candidate is 409 UTILITY_OCR_DECISION_FINAL,
 *   - the agreement check that the accepted reading is on the candidate's Meter
 *     and Building and that `reading.readingValue` equals
 *     `candidateReadingValue` — 400 UTILITY_OCR_READING_MISMATCH otherwise,
 *   - the canonical UTILITY_OCR_CANDIDATE_ACCEPTED operational event.
 *
 * WHAT THE FIELD CALLER CANNOT INSTRUCT
 * -------------------------------------
 * `readingAt` is never passed. BE-18 creates a NEW reading when it is given one,
 * and a field confirmation must never create a reading — the whole point is that
 * the canonical reading already exists. `readingDueId` is never passed either:
 * the due is already COMPLETED by the PART 01 submission, and re-sending it
 * would attempt a second completion and fail the due's `WHERE status = 'DUE'`
 * guard. Only `meterReadingId` — the reading from the route path, itself proven
 * field-authorized above — reaches the canonical service, so the linkage cannot
 * be pointed anywhere else. Both refusals are enforced in validation as explicit
 * rejections, not silent drops.
 */
export async function confirmMobileReadingOcrCandidate(
  readingDueId: string,
  readingId: string,
  candidateId: string,
  actorUserId: string,
  input: MobileReadingOcrConfirmInput,
): Promise<MobileReadingOcrDecisionResult> {
  const context = await authorizeFieldReading(
    readingDueId,
    readingId,
    actorUserId,
  );
  await authorizeOcrCandidateForReading(readingId, candidateId, context);

  const decided = await utilityOcrCandidateService.acceptUtilityOcrCandidate(
    candidateId,
    {
      meterReadingId: context.reading.id,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    },
    actorUserId,
  );
  return { candidate: toMobileOcrSuggestion(decided) };
}

/**
 * Field REJECT of an existing OCR suggestion.
 *
 * Uses BE-18's own `rejectUtilityOcrCandidate`, so the advisory lock, the
 * PENDING_REVIEW precondition, the terminal-decision guard, the existing
 * `decisionNotes` semantics (required, ≤ 1000 characters, persisted as the
 * rejection reason — and mandatory at the database level via
 * `utility_meter_ocr_decision_check`) and the canonical
 * UTILITY_OCR_CANDIDATE_REJECTED event are all preserved unchanged.
 *
 * A rejection MUTATES NOTHING BUT THE CANDIDATE. The reading keeps its value,
 * its provenance and its completed due; rejecting a suggestion is not a
 * correction, not a recheck and not a re-opening of the reading. `accepted_reading_id`
 * stays null, exactly as BE-18 requires for a REJECTED row.
 */
export async function rejectMobileReadingOcrCandidate(
  readingDueId: string,
  readingId: string,
  candidateId: string,
  actorUserId: string,
  input: MobileReadingOcrRejectInput,
): Promise<MobileReadingOcrDecisionResult> {
  const context = await authorizeFieldReading(
    readingDueId,
    readingId,
    actorUserId,
  );
  await authorizeOcrCandidateForReading(readingId, candidateId, context);

  const decided = await utilityOcrCandidateService.rejectUtilityOcrCandidate(
    candidateId,
    input.decisionNotes,
    actorUserId,
  );
  return { candidate: toMobileOcrSuggestion(decided) };
}

/* -------------------------------------------------------------------------
 * Abnormal signal — read projection
 * ---------------------------------------------------------------------- */

/** BE-18J row → the bounded field projection (persisted fields only). */
function toMobileAbnormalSignal(
  record: UtilityAbnormalConsumptionRecord,
): MobileReadingAbnormalSignal {
  return {
    id: record.id,
    consumptionId: record.consumptionId,
    ruleId: record.ruleId,
    abnormalityType: record.abnormalityType,
    comparisonMode: record.comparisonMode,
    detectedValue: Number(record.detectedValue),
    referenceValue:
      record.referenceValue === null ? null : Number(record.referenceValue),
    thresholdValue:
      record.thresholdValue === null ? null : Number(record.thresholdValue),
    uomId: record.uomId,
    periodStart: iso(record.periodStart) ?? '',
    periodEnd: iso(record.periodEnd) ?? '',
    detectedAt: iso(record.detectedAt) ?? '',
    detectedByUserId: record.detectedByUserId,
    status: record.status,
    resolvedAt: iso(record.resolvedAt),
    resolvedByUserId: record.resolvedByUserId,
    resolutionNotes: record.resolutionNotes,
    findingId: record.findingId,
    notes: record.notes,
  };
}

/**
 * The persisted downstream abnormal signal linked to a field reading.
 *
 * Two hops, both EXISTING repository reads, both purely read-only:
 *
 *   utility_meter_consumptions.current_reading_id = reading.id
 *     → `findByCurrentReading(meterId, readingId)`
 *   utility_abnormal_consumptions.consumption_id = that consumption
 *     → `listByConsumption(consumptionId)`
 *
 * NOTHING IS EVALUATED. No rule is loaded, no threshold or baseline is read, no
 * comparison is performed, no consumption is calculated and no abnormality row is
 * created. BE-18G calculation
 * (`POST /utility/meters/:id/consumptions`) and BE-18J detection
 * (`POST /utility/consumptions/:id/abnormality-evaluations`) remain their own
 * commands, triggered by their own callers; this contract can never trigger
 * either, so reading a signal can never cause one to exist.
 *
 * AN EMPTY LIST IS NOT A VERDICT. `signals: []` means only that no abnormality
 * row is persisted against this reading. It does not mean the reading is normal,
 * and it does not mean it was ever evaluated — `consumptionId: null` says BE-18G
 * has not even anchored a consumption on this reading, while a set
 * `consumptionId` with no signals says a consumption exists and BE-18J has
 * persisted nothing against it. `evaluated` reports which of those states is
 * persisted; it never claims anything about the meter.
 *
 * No reading-level `isAbnormal`, `abnormalReason` or `requiresRecheck` field is
 * derived from this projection anywhere in the contract: collapsing persisted
 * detection history into one boolean on the reading is exactly the invention this
 * projection exists to avoid.
 */
export async function listMobileReadingAbnormalSignals(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
): Promise<MobileReadingAbnormalSignalProjection> {
  const context = await authorizeFieldReading(
    readingDueId,
    readingId,
    actorUserId,
  );
  return buildAbnormalSignalProjection(context.reading.id, context.reading.meterId);
}

async function buildAbnormalSignalProjection(
  readingId: string,
  meterId: string,
): Promise<MobileReadingAbnormalSignalProjection> {
  const empty: MobileReadingAbnormalSignalProjection = {
    consumptionId: null,
    evaluated: false,
    truncated: false,
    signals: [],
  };

  const consumption =
    await utilityMeterConsumptionRepository.findByCurrentReading(
      meterId,
      readingId,
    );
  if (!consumption) return empty;

  // Fail closed on a context divergence rather than projecting a signal that
  // belongs to another Client or Building. BE-18G writes these together with the
  // reading, so this is defensive, not a routine path.
  const reading = await utilityMeterReadingRepository.findById(readingId);
  if (
    !reading ||
    consumption.clientId !== reading.clientId ||
    consumption.buildingId !== reading.buildingId ||
    consumption.meterId !== reading.meterId
  ) {
    return empty;
  }

  const rows = await utilityAbnormalConsumptionRepository.listByConsumption(
    consumption.id,
  );
  return {
    consumptionId: consumption.id,
    evaluated: rows.length > 0,
    truncated: rows.length > MOBILE_READING_ABNORMAL_SIGNAL_LIMIT,
    signals: rows
      .slice(0, MOBILE_READING_ABNORMAL_SIGNAL_LIMIT)
      .map(toMobileAbnormalSignal),
  };
}

/* -------------------------------------------------------------------------
 * Reading DETAIL
 * ---------------------------------------------------------------------- */

/**
 * The mobile field reading DETAIL: PART 01's bounded reading plus the four
 * additive PART 02 projections.
 *
 * Strictly additive — every PART 01 field keeps its exact name, type and value,
 * and the LIST route stays on the lightweight DTO. The four projections are
 * fetched together, each through its own authoritative owner, and each bounded.
 *
 * AUTHORITY: PART 01's, DELIBERATELY UNCHANGED
 * --------------------------------------------
 * This function authorizes through PART 01's own `getMobileUtilityMeterReading`
 * — the DUE-keyed gate (`assertUtilityMeterFieldActor` on the path's
 * `readingDueId`) followed by the same-meter check that reports a foreign
 * reading as 404 — and NOT through the reading-keyed
 * `assertUtilityMeterReadingFieldActor` seam the dedicated PART 02 routes use.
 *
 * That is a considered distinction, not an oversight, and the two gates answer
 * different questions:
 *
 *   - the DETAIL is a READ of a reading inside an execution the actor is
 *     assigned to. PART 01 already pins its scope: any canonical reading OF THE
 *     DUE'S METER is readable, including one a management route, an import or the
 *     BE-10C engineering workflow posted. Narrowing that here would have revoked
 *     a PART 01 contract right (a technician inspecting the meter's own history
 *     at the point of capture) in order to add four read projections to it.
 *     Authorization still runs BEFORE existence, so an unassigned actor gets the
 *     PART 00 403 and a random reading id never becomes a probe.
 *
 *   - the dedicated evidence / OCR / abnormal-signal routes ACT on one specific
 *     reading: they upload and remove evidence for it and record a human decision
 *     against it. Those are exactly the operations the reading-keyed seam exists
 *     to restrict, and through them a reading with no field due behind it is not
 *     field-accessible at all — a field actor can never attach evidence to, or
 *     decide an OCR suggestion for, a reading somebody else posted.
 *
 * So the projections below are read models of whatever reading PART 01 already
 * authorized, while every WRITE and every decision on this surface requires the
 * reading to be the due's own field submission.
 *
 * None of the projections can alter the reading. Whatever
 * `evidenceValidation.ready` says, however many suggestions are pending, and
 * whatever signals are persisted, the reading facts returned alongside them are
 * the canonical BE-18E row — evidence readiness is documented and reported
 * separately from reading validity, and a genuine reading is never rejected,
 * reopened or deleted by this contract.
 */
export async function getMobileUtilityMeterReadingDetail(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
): Promise<MobileUtilityMeterReadingDetail> {
  // PART 01's authority and PART 01's bounded DTO, unchanged.
  const reading = await getMobileUtilityMeterReading(
    readingDueId,
    readingId,
    actorUserId,
  );

  const [evidenceValidation, evidenceSummary, ocrCandidates, abnormalSignals] =
    await Promise.all([
      validateReadingEvidence(readingId, actorUserId),
      buildMobileReadingEvidenceSummary(readingId, actorUserId),
      buildOcrSuggestions(readingId),
      buildAbnormalSignalProjection(reading.id, reading.meterId),
    ]);

  return {
    ...reading,
    evidenceValidation,
    evidenceSummary,
    ocrCandidates,
    abnormalSignals,
  };
}

export const mobileUtilityMeterReadingVerificationService = {
  confirmMobileReadingOcrCandidate,
  getMobileUtilityMeterReadingDetail,
  listMobileReadingAbnormalSignals,
  listMobileReadingEvidence,
  listMobileReadingOcrCandidates,
  rejectMobileReadingOcrCandidate,
  removeMobileReadingEvidence,
  submitMobileReadingEvidenceFile,
  validateMobileReadingEvidence,
};
