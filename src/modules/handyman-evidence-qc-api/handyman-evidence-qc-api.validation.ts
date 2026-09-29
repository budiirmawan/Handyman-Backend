import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/**
 * CR-HM-10 PART 06 — evidence/QC/defect HTTP input validation.
 * Whitelist parsers ONLY: bounded scalar fields rebuilt from
 * scratch; ids arrive from the URL. EVERY authority-shaped field —
 * actorUserId / clientId / status / timestamps / transitions /
 * provenance beyond the bounded arguments — is structurally IGNORED
 * (never spread, never forwarded). Exact legal bounds stay with
 * the PART 03–05 services. ZERO pricing/billing/payment/FM field
 * can exist on any request shape.
 */

const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function fail(
  message: string,
  details: { field: string; message: string }[],
): never {
  throw AppError.validation(message, details);
}

function uuid(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isValidUuid(raw)) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return raw;
}

function uuidOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return uuid(value, field);
}

function key(value: unknown, field = 'idempotencyKey'): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) {
    fail('Request validation failed.', [
      { field, message: 'idempotencyKey is required.' },
    ]);
  }
  if (raw.length > 128) {
    fail('Request validation failed.', [
      { field, message: 'idempotencyKey must not exceed 128 characters.' },
    ]);
  }
  return raw;
}

function shortText(value: unknown, field: string,
  maxLength: number, required = true): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 && required) {
    fail('Request validation failed.', [
      { field, message: `${field} is required.` },
    ]);
  }
  if (raw.length > maxLength) {
    fail('Request validation failed.', [
      { field, message: `${field} must not exceed ${maxLength} characters.` },
    ]);
  }
  return raw;
}

function nullableText(value: unknown, field: string,
  maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const raw = shortText(value, field, maxLength, false);
  return raw.length === 0 ? null : raw;
}

/* ---- Path parameters -------------------------------------------- */

export function parseScopeParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'executionScopeId');
}

export function parseEvidenceRecordIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'evidenceRecordId');
}

export function parseQcRunIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'qcRunId');
}

export function parseDefectIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'defectId');
}

/* ---- Evidence bodies -------------------------------------------- */

/** CREATE evidence record: scope from URL; stage/description only. */
export function parseEvidenceCreateBody(body: unknown): {
  stage: string;
  description: string | null;
  sessionId: string | null;
  idempotencyKey: string;
} {
  const source = (body ?? {}) as Record<string, unknown>;
  return {
    stage: shortText(source.stage, 'stage', 64),
    description: nullableText(source.description, 'description',
      2000),
    sessionId: uuidOrNull(source.sessionId, 'sessionId'),
    idempotencyKey: key(source.idempotencyKey),
  };
}

/**
 * FILE_ADD: bounded storage reference only (NO bytes). Exact
 * MIME/size/digest/skew checks live in the PART 03 service.
 */
export function parseEvidenceFileAddBody(body: unknown): {
  mediaKind: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256Digest: string;
  captureTime: string | null;
  idempotencyKey: string;
} {
  const source = (body ?? {}) as Record<string, unknown>;
  const byteSize = typeof source.byteSize === 'number'
    ? source.byteSize
    : Number.NaN;
  if (!Number.isFinite(byteSize)) {
    fail('Request validation failed.', [
      { field: 'byteSize', message: 'byteSize must be a finite number.' },
    ]);
  }
  const captureRaw = source.captureTime;
  let captureTime: string | null = null;
  if (captureRaw !== undefined && captureRaw !== null) {
    captureTime = shortText(captureRaw, 'captureTime', 64);
  }
  return {
    mediaKind: shortText(source.mediaKind, 'mediaKind', 32),
    storageKey: shortText(source.storageKey, 'storageKey', 512),
    contentType: shortText(source.contentType, 'contentType', 128),
    byteSize,
    sha256Digest: shortText(source.sha256Digest, 'sha256Digest', 128),
    captureTime,
    idempotencyKey: key(source.idempotencyKey),
  };
}

/** Key-only mutation body (FINALIZE / FINISH / defect ladder). */
export function parseKeyedBody(body: unknown): {
  idempotencyKey: string;
} {
  const source = (body ?? {}) as Record<string, unknown>;
  return { idempotencyKey: key(source.idempotencyKey) };
}

/* ---- QC bodies --------------------------------------------------- */

/** OPEN run: checklist identity text; session link optional. */
export function parseQcOpenBody(body: unknown): {
  checklistIdentity: string;
  sessionId: string | null;
  idempotencyKey: string;
} {
  const source = (body ?? {}) as Record<string, unknown>;
  return {
    checklistIdentity: shortText(source.checklistIdentity,
      'checklistIdentity', 200),
    sessionId: uuidOrNull(source.sessionId, 'sessionId'),
    idempotencyKey: key(source.idempotencyKey),
  };
}

/** ITEM_SET: itemKey + outcome + optional note. */
export function parseQcItemSetBody(body: unknown): {
  itemKey: string;
  outcome: string;
  note: string | null;
  idempotencyKey: string;
} {
  const source = (body ?? {}) as Record<string, unknown>;
  return {
    itemKey: shortText(source.itemKey, 'itemKey', 128),
    outcome: shortText(source.outcome, 'outcome', 64),
    note: nullableText(source.note, 'note', 2000),
    idempotencyKey: key(source.idempotencyKey),
  };
}

/* ---- Defect bodies ----------------------------------------------- */

/** OPEN_DEFECT: description + optional run/item provenance links. */
export function parseDefectOpenBody(body: unknown): {
  description: string;
  runId: string | null;
  itemId: string | null;
  idempotencyKey: string;
} {
  const source = (body ?? {}) as Record<string, unknown>;
  return {
    description: shortText(source.description, 'description', 4000),
    runId: uuidOrNull(source.runId, 'runId'),
    itemId: uuidOrNull(source.itemId, 'itemId'),
    idempotencyKey: key(source.idempotencyKey),
  };
}
