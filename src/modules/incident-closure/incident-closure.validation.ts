import {
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  failValidation,
  isIncidentStatus,
  isIncidentType,
  isRecord,
  readEnum,
  readNullableText,
  readUuid,
  rejectForbiddenFields,
  type ValidationDetail,
} from '../incidents';
import type {
  CloseIncidentInput,
  IncidentClosureFilters,
} from './incident-closure.types';

export type { ValidationDetail };

const MAX_NOTES_LENGTH = 4000;

/**
 * Fields the backend owns. Refused rather than ignored, so a caller always
 * learns their intent was not honoured.
 *
 * `closeable`, `blockers`, and `facts` are refused specifically: closure
 * readiness is COMPUTED by the backend from current corrective-action and
 * verification state. A client asserting `closeable: true` must never be able
 * to talk the backend past its own rules.
 *
 * `closedByUserId` is refused because the closer is always the authenticated
 * actor — sealing an Incident under someone else's name would destroy the
 * accountability the record exists to provide.
 */
const DERIVED_FIELDS = [
  'status',
  'incidentStatus',
  'closed',
  'closeable',
  'blockers',
  'facts',
  'closedAt',
  'closedByUserId',
  'clientId',
  'buildingId',
  'evaluatedAt',
] as const;

function describeForbidden(field: string): string {
  if (field === 'closedByUserId') {
    return 'The closing user is always the authenticated user.';
  }
  if (field === 'closeable' || field === 'blockers' || field === 'facts') {
    return 'Closure readiness is computed by the backend and cannot be asserted.';
  }
  if (field === 'status' || field === 'incidentStatus' || field === 'closed') {
    return 'The Incident status is derived by the backend.';
  }
  return 'This field is derived by the backend.';
}

export function parseIncidentIdParam(raw: string): string {
  const details: ValidationDetail[] = [];
  const value = readUuid(raw, 'incidentId', true, details);
  if (!value || details.length > 0) failValidation(details);
  return value;
}

/** Closing takes an optional note and nothing else. */
export function parseCloseIncidentBody(body: unknown): CloseIncidentInput {
  // Closing with no body is valid: "resolved, now, by me".
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(body, DERIVED_FIELDS, describeForbidden);

  const details: ValidationDetail[] = [];
  const closureNotes = readNullableText(
    body.closureNotes,
    'closureNotes',
    MAX_NOTES_LENGTH,
    details,
  );
  if (details.length > 0) failValidation(details);

  return { ...(closureNotes !== undefined ? { closureNotes } : {}) };
}

function readBooleanFlag(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  details.push({ field, message: `${field} must be true or false.` });
  return undefined;
}

export function parseClosureFilters(query: unknown): IncidentClosureFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];

  const buildingId = readUuid(query.buildingId, 'buildingId', false, details);
  const incidentType = readEnum(
    query.incidentType,
    'incidentType',
    isIncidentType,
    INCIDENT_TYPES,
    false,
    details,
  );
  const status = readEnum(
    query.status,
    'status',
    isIncidentStatus,
    INCIDENT_STATUSES,
    false,
    details,
  );
  const closeable = readBooleanFlag(query.closeable, 'closeable', details);
  if (details.length > 0) failValidation(details);

  return {
    ...(buildingId ? { buildingId } : {}),
    ...(incidentType ? { incidentType } : {}),
    ...(status ? { status } : {}),
    ...(closeable !== undefined ? { closeable } : {}),
  };
}
