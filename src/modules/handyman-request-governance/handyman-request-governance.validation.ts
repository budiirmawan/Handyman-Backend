import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_GOVERNANCE_ROW_STATUSES,
  HANDYMAN_SERVICE_SELECTION_SOURCES,
  HANDYMAN_TRIAGE_PATHS,
  type HandymanGovernanceRowStatus,
  type HandymanServiceSelectionSource,
  type HandymanTriagePath,
} from './handyman-request-governance.types';

/**
 * CR-HM-BE-03 RUN 4 — strict HTTP contract for the governed request
 * governance surfaces (triage / request-service selection / inspection).
 * The transport layer accepts ONLY the allowlisted fields; every other key —
 * including protected server-derived authority fields — is rejected with
 * 400 VALIDATION_ERROR details. All business authority (lifecycle guards,
 * tenant validation, service-catalog governance, access enforcement) stays
 * in the Run 1 governance services; this module only governs the wire shape.
 */

type Detail = { field: string; message: string };

export const TRIAGE_HANDYMAN_REQUEST_HTTP_BODY_FIELDS = ['path', 'notes'] as const;

export const SELECT_HANDYMAN_REQUEST_SERVICE_HTTP_BODY_FIELDS = [
  'serviceCatalogId',
  'source',
] as const;

export const OPEN_HANDYMAN_INSPECTION_HTTP_BODY_FIELDS = [
  'checklistExecutionId',
] as const;

export const COMPLETE_HANDYMAN_INSPECTION_HTTP_BODY_FIELDS = [
  'diagnosis',
  'scopeNotes',
] as const;

const GOVERNANCE_ROW_PROTECTED_FIELDS: Record<string, string> = {
  id: 'Row id is server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
  status: 'Row status is server-managed by the governed lifecycle.',
};

/** Protected triage fields — request scope comes from the route, actor and
 * lifecycle fields from the session/service. */
const CREATE_TRIAGE_PROTECTED_FIELDS: Record<string, string> = {
  ...GOVERNANCE_ROW_PROTECTED_FIELDS,
  requestId: 'Request id comes from the route and is not accepted in the body.',
  clientId: 'Client identity is derived from the governed request.',
  buildingId: 'Building scope is derived from the governed request.',
  triagedByUserId: 'Triaged-by identity comes from the authenticated actor.',
  triagedAt: 'Timestamps are server-generated.',
  supersededAt: 'Supersede lifecycle is server-managed (append-only history).',
  supersededByUserId: 'Supersede lifecycle is server-managed (append-only history).',
};

const SELECT_SERVICE_PROTECTED_FIELDS: Record<string, string> = {
  ...GOVERNANCE_ROW_PROTECTED_FIELDS,
  requestId: 'Request id comes from the route and is not accepted in the body.',
  clientId: 'Client identity is derived from the governed request.',
  buildingId: 'Building scope is derived from the governed request.',
  selectedByUserId: 'Selected-by identity comes from the authenticated actor.',
  selectedAt: 'Timestamps are server-generated.',
  supersededAt: 'Supersede lifecycle is server-managed (append-only history).',
  supersededByUserId: 'Supersede lifecycle is server-managed (append-only history).',
  description:
    'Free-text service classification is not exposed; selection binds an existing ACTIVE service-catalog entry.',
  serviceName:
    'Free-text service classification is not exposed; selection binds an existing ACTIVE service-catalog entry.',
};

const OPEN_INSPECTION_PROTECTED_FIELDS: Record<string, string> = {
  ...GOVERNANCE_ROW_PROTECTED_FIELDS,
  requestId: 'Request id comes from the route and is not accepted in the body.',
  clientId: 'Client identity is derived from the governed request.',
  buildingId: 'Building scope is derived from the governed request.',
  spaceId: 'Space identity is derived from the governed request.',
  diagnosis: 'Diagnosis is recorded on completion, never at open time.',
  scopeNotes: 'Scope notes are recorded on completion, never at open time.',
  openedByUserId: 'Opened-by identity comes from the authenticated actor.',
  openedAt: 'Timestamps are server-generated.',
  inspectedByUserId: 'Inspected-by identity comes from the authenticated actor.',
  inspectedAt: 'Timestamps are server-generated.',
};

const COMPLETE_INSPECTION_PROTECTED_FIELDS: Record<string, string> = {
  ...GOVERNANCE_ROW_PROTECTED_FIELDS,
  requestId: 'Request scope is immutable and comes from the route.',
  checklistExecutionId:
    'The checklist execution binding is fixed at open time and immutable on completion.',
  openedByUserId: 'Opened-by identity is immutable.',
  openedAt: 'Timestamps are server-generated.',
  inspectedByUserId: 'Inspected-by identity comes from the authenticated actor.',
  inspectedAt: 'Timestamps are server-generated.',
};

const TRIAGE_PATH_VALUES = new Set<string>(HANDYMAN_TRIAGE_PATHS);
const SELECTION_SOURCE_VALUES = new Set<string>(HANDYMAN_SERVICE_SELECTION_SOURCES);
const GOVERNANCE_ROW_STATUS_VALUES = new Set<string>(HANDYMAN_GOVERNANCE_ROW_STATUSES);

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(raw: unknown, field: string, label: string): string {
  if (typeof raw !== 'string') {
    fail([{ field, message: `${label} must be a string.` }]);
  }
  const value = (raw as string).trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${label} must be a valid UUID.` }]);
  }
  return value;
}

function assertAllowedFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  protectedFields: Record<string, string>,
  details: Detail[],
): void {
  for (const field of Object.keys(body)) {
    const protectedMessage = protectedFields[field];
    if (protectedMessage) {
      details.push({ field, message: protectedMessage });
      continue;
    }
    if (!(allowed as readonly string[]).includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
}

function readOptionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  details: Detail[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return null;
  }
  return trimmed;
}

function readEnum(
  value: unknown,
  field: string,
  values: Set<string>,
  label: string,
  details: Detail[],
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!values.has(normalized)) {
    details.push({
      field,
      message: `${label} must be one of ${[...values].join(', ')}.`,
    });
    return null;
  }
  return normalized;
}

/** Command endpoints with no caller-authoritative payload (supersede,
 * inspection cancel): the body must be absent or an empty JSON object; ANY
 * key is rejected. */
export function parseEmptyCommandBody(
  body: unknown,
  protectedFields: Record<string, string> = {},
): void {
  if (body === undefined || body === null) return;
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  for (const field of Object.keys(body)) {
    const protectedMessage = protectedFields[field];
    details.push({
      field,
      message: protectedMessage ?? `${field} is not allowed.`,
    });
  }
  if (details.length > 0) fail(details);
}

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

export function parseHandymanRequestIdPathParam(raw: string): string {
  return parseUuidParam(raw, 'handymanRequestId', 'Handyman request id');
}

export function parseHandymanRequestTriageIdParam(raw: string): string {
  return parseUuidParam(raw, 'triageId', 'Triage id');
}

export function parseHandymanRequestServiceIdParam(raw: string): string {
  return parseUuidParam(raw, 'selectionId', 'Request service selection id');
}

export function parseHandymanInspectionIdParam(raw: string): string {
  return parseUuidParam(raw, 'inspectionId', 'Inspection id');
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** `POST /handyman-requests/:handymanRequestId/triages` body → `{ path, notes? }`. */
export function parseTriageHandymanRequestHttpBody(body: unknown): {
  path: HandymanTriagePath;
  notes: string | null;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    TRIAGE_HANDYMAN_REQUEST_HTTP_BODY_FIELDS,
    CREATE_TRIAGE_PROTECTED_FIELDS,
    details,
  );

  const path = readEnum(body.path, 'path', TRIAGE_PATH_VALUES, 'Triage path', details);
  const notes = readOptionalBoundedString(body.notes, 'notes', 2000, details);

  if (details.length > 0) fail(details);
  return { path: path as HandymanTriagePath, notes };
}

/** `POST /handyman-requests/:handymanRequestId/services` body →
 * `{ serviceCatalogId, source }`. */
export function parseSelectHandymanRequestServiceHttpBody(body: unknown): {
  serviceCatalogId: string;
  source: HandymanServiceSelectionSource;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    SELECT_HANDYMAN_REQUEST_SERVICE_HTTP_BODY_FIELDS,
    SELECT_SERVICE_PROTECTED_FIELDS,
    details,
  );

  const serviceCatalogId = body.serviceCatalogId;
  if (typeof serviceCatalogId !== 'string' || serviceCatalogId.trim() === '') {
    details.push({ field: 'serviceCatalogId', message: 'Service catalog id is required.' });
  } else if (!isValidUuid(serviceCatalogId.trim().toLowerCase())) {
    details.push({
      field: 'serviceCatalogId',
      message: 'Service catalog id must be a valid UUID.',
    });
  }

  const source = readEnum(
    body.source,
    'source',
    SELECTION_SOURCE_VALUES,
    'Selection source',
    details,
  );

  if (details.length > 0) fail(details);
  return {
    serviceCatalogId: (serviceCatalogId as string).trim().toLowerCase(),
    source: source as HandymanServiceSelectionSource,
  };
}

/** `GET /handyman-requests/:handymanRequestId/services?status=` → optional
 * ACTIVE|SUPERSEDED history filter. */
export function parseHandymanRequestServiceListQuery(query: unknown): {
  status?: HandymanGovernanceRowStatus;
} {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  for (const field of Object.keys(query)) {
    if (field !== 'status') {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
  const raw = query.status;
  if (raw === undefined || raw === null || raw === '') {
    if (details.length > 0) fail(details);
    return {};
  }
  const status = readEnum(
    raw,
    'status',
    GOVERNANCE_ROW_STATUS_VALUES,
    'Status filter',
    details,
  );
  if (details.length > 0) fail(details);
  return { status: status as HandymanGovernanceRowStatus };
}

/** `POST /handyman-requests/:handymanRequestId/inspections` body →
 * `{ checklistExecutionId? }` — the existing checklist-execution binding only. */
export function parseOpenHandymanInspectionHttpBody(body: unknown): {
  checklistExecutionId: string | null;
} {
  if (body === undefined || body === null) return { checklistExecutionId: null };
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    OPEN_HANDYMAN_INSPECTION_HTTP_BODY_FIELDS,
    OPEN_INSPECTION_PROTECTED_FIELDS,
    details,
  );

  let checklistExecutionId: string | null = null;
  const raw = body.checklistExecutionId;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      details.push({
        field: 'checklistExecutionId',
        message: 'Checklist execution id must be a non-empty string or null.',
      });
    } else if (!isValidUuid(raw.trim().toLowerCase())) {
      details.push({
        field: 'checklistExecutionId',
        message: 'Checklist execution id must be a valid UUID.',
      });
    } else {
      checklistExecutionId = raw.trim().toLowerCase();
    }
  }

  if (details.length > 0) fail(details);
  return { checklistExecutionId };
}

/** `POST /handyman-inspections/:inspectionId/complete` body →
 * `{ diagnosis, scopeNotes }`. */
export function parseCompleteHandymanInspectionHttpBody(body: unknown): {
  diagnosis: string;
  scopeNotes: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  assertAllowedFields(
    body,
    COMPLETE_HANDYMAN_INSPECTION_HTTP_BODY_FIELDS,
    COMPLETE_INSPECTION_PROTECTED_FIELDS,
    details,
  );

  const diagnosis = readOptionalBoundedString(body.diagnosis, 'diagnosis', 4000, details);
  if (diagnosis === null) {
    details.push({ field: 'diagnosis', message: 'Diagnosis is required.' });
  }
  const scopeNotes = readOptionalBoundedString(body.scopeNotes, 'scopeNotes', 2000, details);
  if (scopeNotes === null) {
    details.push({ field: 'scopeNotes', message: 'Scope notes are required.' });
  }

  if (details.length > 0) fail(details);
  return { diagnosis: diagnosis as string, scopeNotes: scopeNotes as string };
}
