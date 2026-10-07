import { AppError } from '../../shared/errors';
import { parseReadingEvidenceIdParam } from '../utility-meter-reading-evidence';
import { parseOcrId } from '../utility-ocr-candidates';
import {
  MOBILE_READING_EVIDENCE_BODY_FIELDS,
  MOBILE_READING_EVIDENCE_DERIVED_FIELDS,
  MOBILE_READING_OCR_CONFIRM_BODY_FIELDS,
  MOBILE_READING_OCR_DERIVED_FIELDS,
  MOBILE_READING_OCR_REJECT_BODY_FIELDS,
  type MobileReadingEvidenceUploadInput,
  type MobileReadingOcrConfirmInput,
  type MobileReadingOcrRejectInput,
} from './mobile-utility-meter-reading-verification.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — mobile field reading-verification
 * validation.
 *
 * Strict by construction, on the PART 01 pattern: every body is an allowlist
 * that behaves as `additionalProperties: false`, and an AUTHORITY key is refused
 * with the specific reason it is server-derived rather than silently dropped. A
 * field client must never be able to discover by trial that supplying
 * `fileReference`, `readingAt` or `meterReadingId` was quietly ignored — silence
 * would leave it believing it had steered where the bytes are stored or which
 * reading an OCR suggestion was confirmed against.
 *
 * Path parameters are parsed by the EXISTING BE-18 validators
 * (`parseReadingEvidenceIdParam`, `parseOcrId`) and by PART 01's own param
 * parsers, never by copies, so the UUID rule, lowercase normalization and
 * `VALIDATION_ERROR` envelope stay single-sourced.
 *
 * Deliberately NOT validated here, because a single authoritative owner already
 * does it: MIME-per-evidence-type, requirement maximum counts, requirement
 * type/reading/client binding (all BE-18F `submitReadingEvidence`), the 50 MB
 * ceiling (multer + the BE-07 `file_size` constraint), candidate value equality
 * and Meter/Building agreement (BE-18 `acceptUtilityOcrCandidate`).
 * Re-implementing any of them here would create a second, divergent rule.
 */

type ValidationDetail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/** A multipart text field arrives as a string or an array of strings. */
function text(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Refuses every key outside the allowlist, naming the reason for the authority
 * keys. Shared by all three field bodies so the refusal semantics cannot drift
 * between evidence upload and OCR decisions.
 */
function rejectForeignKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  derived: Readonly<Record<string, string>>,
): void {
  const allow = new Set<string>(allowed);
  const rejected: ValidationDetail[] = [];
  for (const key of Object.keys(body)) {
    if (allow.has(key)) continue;
    rejected.push({
      field: key,
      message:
        derived[key] ?? `${key} is not accepted by this command.`,
    });
  }
  if (rejected.length > 0) fail(rejected);
}

/** `evidenceId` path parameter — the existing BE-18F validator. */
export function parseMobileReadingEvidenceIdParam(raw: string): string {
  return parseReadingEvidenceIdParam(raw);
}

/** `candidateId` path parameter — the existing BE-18 OCR validator. */
export function parseMobileOcrCandidateIdParam(raw: string): string {
  return parseOcrId(raw, 'candidateId');
}

/**
 * The multipart TEXT fields of a field evidence upload.
 *
 * `evidenceType` is required and must be one of the three BE-07 types (reused
 * verbatim — BE-18F adds none). `evidenceRequirementId`, `capturedAt` and
 * `originalFileName` are optional; when present they must be well-formed.
 *
 * Everything else about the submission is server-derived: the reading and its
 * Client/Building from BE-18E, the actor from the session, the storage key and
 * the MIME type and size from the uploaded bytes, and the integrity hash from
 * the exact buffer handed to storage.
 */
export function parseMobileReadingEvidenceUploadFields(
  body: unknown,
): MobileReadingEvidenceUploadInput {
  const record: Record<string, unknown> = isRecord(body)
    ? body
    : {};
  rejectForeignKeys(
    record,
    MOBILE_READING_EVIDENCE_BODY_FIELDS,
    MOBILE_READING_EVIDENCE_DERIVED_FIELDS,
  );

  const details: ValidationDetail[] = [];

  const evidenceType = text(record.evidenceType);
  if (
    evidenceType === undefined ||
    !['PHOTO', 'DOCUMENT', 'SIGNATURE'].includes(evidenceType)
  ) {
    details.push({
      field: 'evidenceType',
      message: 'evidenceType must be PHOTO, DOCUMENT or SIGNATURE.',
    });
  }

  const evidenceRequirementId = text(record.evidenceRequirementId);
  if (record.evidenceRequirementId !== undefined && evidenceRequirementId === undefined) {
    details.push({
      field: 'evidenceRequirementId',
      message: 'evidenceRequirementId must be a non-empty UUID string.',
    });
  }

  const capturedAt = text(record.capturedAt);
  if (record.capturedAt !== undefined) {
    if (capturedAt === undefined || Number.isNaN(new Date(capturedAt).getTime())) {
      details.push({
        field: 'capturedAt',
        message: 'capturedAt must be a valid ISO 8601 timestamp.',
      });
    }
  }

  const originalFileName = text(record.originalFileName);
  if (
    record.originalFileName !== undefined &&
    originalFileName === undefined
  ) {
    details.push({
      field: 'originalFileName',
      message: 'originalFileName must be a non-empty string.',
    });
  }

  if (details.length > 0 || evidenceType === undefined) {
    fail(
      details.length > 0
        ? details
        : [{ field: 'evidenceType', message: 'evidenceType is required.' }],
    );
  }

  return {
    evidenceType: evidenceType as 'PHOTO' | 'DOCUMENT' | 'SIGNATURE',
    ...(evidenceRequirementId === undefined
      ? {}
      : { evidenceRequirementId }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(originalFileName === undefined ? {} : { originalFileName }),
  };
}

/**
 * The field OCR CONFIRM body: `{ notes? }` — nothing else.
 *
 * The absence of `readingAt` / `meterReadingId` / `readingDueId` is the whole
 * point (see MOBILE_READING_OCR_DERIVED_FIELDS): a field confirmation links a
 * suggestion to the reading the technician already recorded, and can never
 * instruct the backend to create a reading or to complete a due again.
 *
 * `notes` bound reproduces BE-18's own accept validator (≤ 1000 characters,
 * null allowed) rather than inventing a field-specific one.
 */
export function parseMobileReadingOcrConfirmBody(
  body: unknown,
): MobileReadingOcrConfirmInput {
  const record: Record<string, unknown> = isRecord(body) ? body : {};
  rejectForeignKeys(
    record,
    MOBILE_READING_OCR_CONFIRM_BODY_FIELDS,
    MOBILE_READING_OCR_DERIVED_FIELDS,
  );

  if (record.notes === undefined) return {};

  const details: ValidationDetail[] = [];
  let notes: string | null | undefined;
  if (record.notes === null) {
    notes = null;
  } else if (typeof record.notes !== 'string') {
    details.push({ field: 'notes', message: 'notes must be null or a string.' });
  } else {
    const trimmed = record.notes.trim();
    if (trimmed.length > 1000) {
      details.push({
        field: 'notes',
        message: 'notes must be at most 1000 characters.',
      });
    } else {
      notes = trimmed.length > 0 ? trimmed : null;
    }
  }

  if (details.length > 0) fail(details);
  return notes === undefined ? {} : { notes };
}

/**
 * The field OCR REJECT body: `{ decisionNotes }` — required and non-empty.
 *
 * The requirement is not a field invention: `utility_meter_ocr_decision_check`
 * (0281) makes `decision_notes` NOT NULL mandatory on a REJECTED row, so a
 * rejection without a reason cannot be persisted at all. The bound reproduces
 * BE-18's own reject validator (≤ 1000 characters).
 */
export function parseMobileReadingOcrRejectBody(
  body: unknown,
): MobileReadingOcrRejectInput {
  const record: Record<string, unknown> = isRecord(body) ? body : {};
  rejectForeignKeys(
    record,
    MOBILE_READING_OCR_REJECT_BODY_FIELDS,
    MOBILE_READING_OCR_DERIVED_FIELDS,
  );

  const notes = typeof record.decisionNotes === 'string'
    ? record.decisionNotes.trim()
    : '';
  if (notes.length === 0 || notes.length > 1000) {
    fail([
      {
        field: 'decisionNotes',
        message:
          'decisionNotes is required and must be at most 1000 characters.',
      },
    ]);
  }
  return { decisionNotes: notes };
}
