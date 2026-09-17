import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { HANDYMAN_VISIT_PRESENCE_MARKS } from './handyman-visit-presence.types';
import type {
  RecordAssistedArrivalInput,
  RecordGpsArrivalInput,
} from './handyman-visit-arrival.types';
import type { RecordAssistedPresenceInput, RecordPresenceByLeadInput } from './handyman-visit-presence.types';
import type { StartHandymanWorkSessionInput } from './handyman-work-session.types';

/**
 * CR-HM-BE-06 RUN 3 — Strict HTTP contract for the field-execution
 * endpoints (arrival, presence, work session). The transport layer accepts
 * ONLY the allowlisted business facts of the EXISTING Run-1/Run-2 service
 * commands:
 *
 *   - GPS arrival      → latitude, longitude, accuracyMeters?, occurredAt?,
 *                        idempotencyKey (the client-claimed coordinates are
 *                        EVIDENCE ONLY — the server is the sole GPS
 *                        verification authority; no result, radius,
 *                        configuration point or building identity is ever
 *                        accepted from the wire),
 *   - assisted arrival → assistedReason, occurredAt?, idempotencyKey (NO
 *                        coordinate is accepted — ASSISTED is a
 *                        provenance-bearing staff override, structurally
 *                        distinguishable from GPS),
 *   - presence (lead)  → vendorWorkforceBindingId, presenceStatus,
 *   - presence (staff) → + assistedReason,
 *   - session start    → idempotencyKey, occurredAt? (everything else is
 *                        server-resolved from the visit),
 *   - session end      → NO business body at all.
 *
 * Every other key — including protected server-derived authority (client /
 * building / job / work-order / vendor-work / assignment / crew identities,
 * verification results, lifecycle statuses, attribution, timestamps) — is
 * rejected with 400 VALIDATION_ERROR details. No mass assignment: the actor
 * always comes from the authenticated session, never from the body.
 * Timestamps are validated as TRANSPORT SHAPE (parseable ISO-8601
 * date-time); coordinate RANGES, verification, lifecycle and conflict
 * semantics stay domain-owned (the domain may deliberately preserve an
 * out-of-range claim as a FAILED attempt). Domain conflicts are never
 * converted into transport errors.
 *
 * Wire note: the assisted-reason field is `assistedReason` on every assisted
 * command — the EXACT Run-1 service input name (governance: one wire
 * vocabulary per command, no controller-side renaming).
 */

type Detail = { field: string; message: string };

export const RECORD_GPS_HANDYMAN_VISIT_ARRIVAL_HTTP_BODY_FIELDS = [
  'latitude',
  'longitude',
  'accuracyMeters',
  'occurredAt',
  'idempotencyKey',
] as const;

export const RECORD_ASSISTED_HANDYMAN_VISIT_ARRIVAL_HTTP_BODY_FIELDS = [
  'assistedReason',
  'occurredAt',
  'idempotencyKey',
] as const;

export const RECORD_HANDYMAN_VISIT_PRESENCE_HTTP_BODY_FIELDS = [
  'vendorWorkforceBindingId',
  'presenceStatus',
] as const;

export const RECORD_ASSISTED_HANDYMAN_VISIT_PRESENCE_HTTP_BODY_FIELDS = [
  'vendorWorkforceBindingId',
  'presenceStatus',
  'assistedReason',
] as const;

export const START_HANDYMAN_WORK_SESSION_HTTP_BODY_FIELDS = [
  'idempotencyKey',
  'occurredAt',
] as const;

/** The end command carries NO business body (the Run-2 signature is
 * `endHandymanWorkSession(sessionId, actorUserId)`). */
export const END_HANDYMAN_WORK_SESSION_HTTP_BODY_FIELDS = [] as const;

/**
 * Protected fields shared by the field-execution commands: server-derived
 * identity, verification authority, lifecycle and attribution. Each carries
 * an explicit rejection message (protected-field rejection, not a generic
 * "unknown key").
 */
const FIELD_EXECUTION_PROTECTED_FIELDS: Record<string, string> = {
  clientId: 'Client id is derived server-side from the visit.',
  buildingId: 'Building identity is derived server-side from the client/job chain.',
  jobId: 'Job identity is derived server-side from the visit.',
  handymanJobId: 'Job identity is derived server-side from the visit.',
  workOrderId: 'Work Order identity is server-resolved; its lifecycle stays on the existing owner.',
  vendorWorkId: 'Vendor work identity is server-resolved; its lifecycle stays on the existing owner.',
  providerId: 'Provider identity is derived server-side from the job assignment.',
  handymanProviderId: 'Provider identity is derived server-side from the job assignment.',
  crewId: 'Crew identity is derived server-side from the job assignment composition.',
  handymanWorkCrewId: 'Crew identity is derived server-side from the job assignment composition.',
  assignmentId: 'Assignment identity is derived server-side from the visit.',
  handymanJobAssignmentId: 'Assignment identity is derived server-side from the visit.',
  visitId: 'Visit id comes from the route.',
  handymanServiceVisitId: 'Visit id comes from the route.',
  status: 'Lifecycle status is server-managed by the domain.',
  result: 'The server is the sole verification authority; results are never accepted.',
  verificationResult: 'The server is the sole verification authority; results are never accepted.',
  verified: 'The server is the sole verification authority; verification flags are never accepted.',
  method: 'The verification method is pinned by the route (GPS vs ASSISTED).',
  verificationMethod: 'The verification method is pinned by the route (GPS vs ASSISTED).',
  distanceMeters: 'The geofence distance is computed server-side from the backend-authoritative configuration.',
  radiusMeters: 'The geofence radius is backend-authoritative configuration; it is never accepted or hardcoded by a caller.',
  insideGeofence: 'Geofence decisions are server-owned.',
  withinRadius: 'Geofence decisions are server-owned.',
  configurationId: 'Configuration identity is resolved server-side.',
  buildingConfigurationId: 'Configuration identity is resolved server-side.',
  configurationVersionId: 'Configuration versioning is server-resolved.',
  receivedAt: 'Server receipt timestamps are server-generated.',
  recordedByUserId: 'Recorder identity comes from the authenticated actor.',
  recordedBy: 'Recorder identity comes from the authenticated actor.',
  recordedAt: 'Recording timestamps are server-generated.',
  userId: 'Worker identity is never taken on faith from the client; the actor comes from the authenticated session.',
  workerId: 'Worker identity is never taken on faith from the client.',
  vendorWorkforceBindingId: 'Binding identity comes from the governed workforce chain, never from this command.',
  deviceId: 'Device identifiers are not part of the governed contract.',
  deviceToken: 'Device identifiers are not part of the governed contract.',
  evidenceUrl: 'Evidence references stay on the server-owned evidence rows.',
  id: 'Ids are server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

/** GPS arrival: identity/verification authority is server-owned; the caller
 * supplies claimed evidence coordinates ONLY. */
const RECORD_GPS_ARRIVAL_PROTECTED_FIELDS: Record<string, string> = {
  ...FIELD_EXECUTION_PROTECTED_FIELDS,
  assistedReason: 'An assisted reason belongs to the ASSISTED arrival route; GPS arrivals carry evidence coordinates.',
};

/** Assisted arrival: NO coordinate or verification fact is ever accepted —
 * ASSISTED must stay structurally distinguishable from GPS. */
const RECORD_ASSISTED_ARRIVAL_PROTECTED_FIELDS: Record<string, string> = {
  ...FIELD_EXECUTION_PROTECTED_FIELDS,
  latitude: 'Assisted arrivals carry NO coordinates — GPS evidence belongs to the GPS arrival route.',
  longitude: 'Assisted arrivals carry NO coordinates — GPS evidence belongs to the GPS arrival route.',
  accuracyMeters: 'Assisted arrivals carry NO coordinates — GPS evidence belongs to the GPS arrival route.',
  gps: 'Assisted arrivals carry NO coordinates — GPS evidence belongs to the GPS arrival route.',
};

/** Presence (lead path): the snapshot row identity is the only accepted
 * target; role/attribution/scope are frozen or server-managed. The binding
 * id is the ALLOWLISTED target here, so it comes off the protected base. */
const RECORD_PRESENCE_PROTECTED_FIELDS: Record<string, string> = {
  ...FIELD_EXECUTION_PROTECTED_FIELDS,
  crewRole: 'The crew role is the FROZEN snapshot identity; it is never accepted from a caller.',
  handymanVisitArrivalId: 'The arrival binding is the frozen snapshot identity.',
  arrivalId: 'The arrival binding is the frozen snapshot identity.',
  recordedVia: 'The recording path is derived from the route (LEAD vs STAFF_ASSISTED).',
  assistedReason: 'An assisted reason belongs to the ASSISTED presence route.',
};

delete (RECORD_PRESENCE_PROTECTED_FIELDS as Record<string, string | undefined>)
  .vendorWorkforceBindingId;

/** Presence (assisted path): identical, minus the assisted-reason ban. */
const RECORD_ASSISTED_PRESENCE_PROTECTED_FIELDS: Record<string, string> = {
  ...FIELD_EXECUTION_PROTECTED_FIELDS,
  crewRole: 'The crew role is the FROZEN snapshot identity; it is never accepted from a caller.',
  handymanVisitArrivalId: 'The arrival binding is the frozen snapshot identity.',
  arrivalId: 'The arrival binding is the frozen snapshot identity.',
  recordedVia: 'The recording path is derived from the route (LEAD vs STAFF_ASSISTED).',
};

delete (RECORD_ASSISTED_PRESENCE_PROTECTED_FIELDS as Record<string, string | undefined>)
  .vendorWorkforceBindingId;

/** Session start: the Run-2 command resolves EVERYTHING authoritative from
 * the visit; the caller supplies replay/business facts only. */
const START_WORK_SESSION_PROTECTED_FIELDS: Record<string, string> = {
  ...FIELD_EXECUTION_PROTECTED_FIELDS,
  sessionId: 'Session id is server-generated.',
  handymanWorkSessionId: 'Session id is server-generated.',
  startedAt: 'Start timestamps are server-generated (an occurredAt claim is evidence only).',
  startedBy: 'Started-by identity comes from the authenticated actor.',
  startedByUserId: 'Started-by identity comes from the authenticated actor.',
  endedAt: 'End facts belong to the end command and are server-generated.',
  endedBy: 'Ended-by identity comes from the authenticated actor.',
  endedByUserId: 'Ended-by identity comes from the authenticated actor.',
  duration: 'Duration is a derived server-side fact.',
  durationMinutes: 'Duration is a derived server-side fact.',
  billableHours: 'Sessions are execution-time facts only — never billing facts.',
  billingRate: 'Sessions are execution-time facts only — never billing facts.',
  laborAmount: 'Sessions are execution-time facts only — never billing facts.',
};

/** Session end: NO business key is accepted; closure attribution and every
 * completion/QC/BAST-adjacent fact stay out of the CR-HM-BE-06 surface. */
const END_WORK_SESSION_PROTECTED_FIELDS: Record<string, string> = {
  ...START_WORK_SESSION_PROTECTED_FIELDS,
  idempotencyKey: 'The end command is replay-safe without a client key; it accepts no business body.',
  occurredAt: 'The end command accepts no business body; closure timestamps are server-generated.',
  reason: 'The end command accepts no business body; attribution is server-managed.',
  completionReason: 'Completion facts do not exist on this surface.',
  outcome: 'Outcome/QC facts do not exist on this surface.',
  resultNotes: 'Notes/QC facts do not exist on this surface.',
};

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

function collectUnknownFields(
  source: Record<string, unknown>,
  allowed: readonly string[],
  protectedFields: Record<string, string>,
  details: Detail[],
): void {
  for (const field of Object.keys(source)) {
    const protectedMessage = protectedFields[field];
    if (protectedMessage) {
      details.push({ field, message: protectedMessage });
      continue;
    }
    if (!allowed.includes(field)) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }
}

/** `:sessionId` path segment → normalized lowercase UUID. The `:visitId`
 * segment parser is the EXISTING `parseHandymanServiceVisitIdParam` from
 * the BE-05 visit validation (one wire vocabulary — never redefined). */
export function parseHandymanWorkSessionIdParam(raw: string): string {
  return parseUuidParam(raw, 'sessionId', 'Work session id');
}

/**
 * One required client-claimed coordinate: TRANSPORT SHAPE only (a finite
 * JSON number). Ranges stay domain-owned — an out-of-range claim is
 * deliberately preserved by Run 1 as a FAILED attempt with its evidence
 * intact, so the transport must NOT pre-reject it.
 */
function requireCoordinateField(
  source: Record<string, unknown>,
  field: 'latitude' | 'longitude',
  label: string,
  details: Detail[],
): number | null {
  const raw = source[field];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    details.push({ field, message: `${label} must be a finite number.` });
    return null;
  }
  return raw;
}

/** Optional claimed accuracy in meters: absent/null → null; otherwise a
 * finite number (interpretation stays with the verification domain). */
function optionalAccuracyMetersField(
  source: Record<string, unknown>,
  details: Detail[],
): number | null {
  const raw = source.accuracyMeters;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    details.push({
      field: 'accuracyMeters',
      message: 'Accuracy meters must be a finite number when provided.',
    });
    return null;
  }
  return raw;
}

/**
 * Optional client-claimed occurrence timestamp (offline-replay evidence).
 * Validated as TRANSPORT SHAPE (parseable ISO-8601 date-time) and passed
 * through as the normalized string; server timestamps (receivedAt,
 * startedAt, recordedAt) remain the authoritative facts.
 */
function optionalOccurredAtField(
  source: Record<string, unknown>,
  details: Detail[],
): string | null {
  const raw = source.occurredAt;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({
      field: 'occurredAt',
      message: 'Occurred-at must be an ISO-8601 date-time string when provided.',
    });
    return null;
  }
  const trimmed = raw.trim();
  if (Number.isNaN(new Date(trimmed).getTime())) {
    details.push({
      field: 'occurredAt',
      message: 'Occurred-at must be a valid ISO-8601 date-time.',
    });
    return null;
  }
  return trimmed;
}

/** Required client idempotency key: non-empty string (replay identity). */
function requireIdempotencyKeyField(
  source: Record<string, unknown>,
  details: Detail[],
): string | null {
  const raw = source.idempotencyKey;
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({
      field: 'idempotencyKey',
      message: 'Idempotency key is required.',
    });
    return null;
  }
  return raw.trim();
}

/** Required non-empty assisted reason (mandatory on every assisted
 * command — provenance without a reason is not an override). */
function requireAssistedReasonField(
  source: Record<string, unknown>,
  details: Detail[],
): string | null {
  const raw = source.assistedReason;
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({
      field: 'assistedReason',
      message: 'Assisted reason is required.',
    });
    return null;
  }
  return raw.trim();
}

/** Required snapshot-row binding target (UUID transport shape; snapshot
 * membership itself stays domain-owned — arbitrary ids are rejected with
 * the domain 404). */
function requireBindingIdField(
  source: Record<string, unknown>,
  details: Detail[],
): string | null {
  const raw = source.vendorWorkforceBindingId;
  if (typeof raw !== 'string' || !isValidUuid(raw.trim().toLowerCase())) {
    details.push({
      field: 'vendorWorkforceBindingId',
      message: 'Vendor workforce binding id must be a valid UUID.',
    });
    return null;
  }
  return raw.trim().toLowerCase();
}

/** Required presence mark: transport enum check over the EXISTING domain
 * vocabulary (PRESENT | ABSENT). PENDING is a server-owned snapshot initial
 * state and is not a caller-markable value. */
function requirePresenceStatusField(
  source: Record<string, unknown>,
  details: Detail[],
): 'PRESENT' | 'ABSENT' | null {
  const raw = source.presenceStatus;
  if (
    typeof raw !== 'string' ||
    !(HANDYMAN_VISIT_PRESENCE_MARKS as readonly string[]).includes(raw)
  ) {
    details.push({
      field: 'presenceStatus',
      message: 'Presence status must be one of PRESENT, ABSENT.',
    });
    return null;
  }
  return raw as 'PRESENT' | 'ABSENT';
}

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  return body;
}

/**
 * `POST /handyman-service-visits/:visitId/arrival` body → the EXACT Run-1
 * GPS arrival command facts. The verification result, distance, radius and
 * configuration point are computed server-side and never accepted.
 */
export function parseGpsArrivalHttpBody(body: unknown): RecordGpsArrivalInput {
  const source = requireObjectBody(body);
  const details: Detail[] = [];
  collectUnknownFields(
    source,
    RECORD_GPS_HANDYMAN_VISIT_ARRIVAL_HTTP_BODY_FIELDS,
    RECORD_GPS_ARRIVAL_PROTECTED_FIELDS,
    details,
  );
  const latitude = requireCoordinateField(source, 'latitude', 'Latitude', details);
  const longitude = requireCoordinateField(
    source,
    'longitude',
    'Longitude',
    details,
  );
  const accuracyMeters = optionalAccuracyMetersField(source, details);
  const occurredAt = optionalOccurredAtField(source, details);
  const idempotencyKey = requireIdempotencyKeyField(source, details);
  if (details.length > 0) {
    fail(details);
  }
  return {
    latitude: latitude as number,
    longitude: longitude as number,
    accuracyMeters,
    occurredAt,
    idempotencyKey: idempotencyKey as string,
  };
}

/**
 * `POST /handyman-service-visits/:visitId/arrival/assisted` body → the
 * EXACT Run-1 assisted arrival command facts. The wire field is
 * `assistedReason` (the service input name); coordinates are structurally
 * rejected so ASSISTED can never masquerade as GPS evidence.
 */
export function parseAssistedArrivalHttpBody(
  body: unknown,
): RecordAssistedArrivalInput {
  const source = requireObjectBody(body);
  const details: Detail[] = [];
  collectUnknownFields(
    source,
    RECORD_ASSISTED_HANDYMAN_VISIT_ARRIVAL_HTTP_BODY_FIELDS,
    RECORD_ASSISTED_ARRIVAL_PROTECTED_FIELDS,
    details,
  );
  const assistedReason = requireAssistedReasonField(source, details);
  const occurredAt = optionalOccurredAtField(source, details);
  const idempotencyKey = requireIdempotencyKeyField(source, details);
  if (details.length > 0) {
    fail(details);
  }
  return {
    assistedReason: assistedReason as string,
    occurredAt,
    idempotencyKey: idempotencyKey as string,
  };
}

/**
 * `POST /handyman-service-visits/:visitId/presence` body → the EXACT Run-1
 * lead-marking command facts. The caller targets one FROZEN snapshot row;
 * crew role, attribution and scope are never accepted.
 */
export function parsePresenceByLeadHttpBody(
  body: unknown,
): RecordPresenceByLeadInput {
  const source = requireObjectBody(body);
  const details: Detail[] = [];
  collectUnknownFields(
    source,
    RECORD_HANDYMAN_VISIT_PRESENCE_HTTP_BODY_FIELDS,
    RECORD_PRESENCE_PROTECTED_FIELDS,
    details,
  );
  const vendorWorkforceBindingId = requireBindingIdField(source, details);
  const presenceStatus = requirePresenceStatusField(source, details);
  if (details.length > 0) {
    fail(details);
  }
  return {
    vendorWorkforceBindingId: vendorWorkforceBindingId as string,
    presenceStatus: presenceStatus as 'PRESENT' | 'ABSENT',
  };
}

/**
 * `POST /handyman-service-visits/:visitId/presence/assisted` body → the
 * EXACT Run-1 staff-assisted command facts (mandatory reason; the real
 * recorder is attributed from the session, never from the body).
 */
export function parseAssistedPresenceHttpBody(
  body: unknown,
): RecordAssistedPresenceInput {
  const source = requireObjectBody(body);
  const details: Detail[] = [];
  collectUnknownFields(
    source,
    RECORD_ASSISTED_HANDYMAN_VISIT_PRESENCE_HTTP_BODY_FIELDS,
    RECORD_ASSISTED_PRESENCE_PROTECTED_FIELDS,
    details,
  );
  const vendorWorkforceBindingId = requireBindingIdField(source, details);
  const presenceStatus = requirePresenceStatusField(source, details);
  const assistedReason = requireAssistedReasonField(source, details);
  if (details.length > 0) {
    fail(details);
  }
  return {
    vendorWorkforceBindingId: vendorWorkforceBindingId as string,
    presenceStatus: presenceStatus as 'PRESENT' | 'ABSENT',
    assistedReason: assistedReason as string,
  };
}

/**
 * `POST /handyman-service-visits/:visitId/work-sessions/start` body → the
 * EXACT Run-2 start command facts. Client, job, work order, vendor work,
 * composition, actor, started_at and status are all server-resolved.
 */
export function parseStartWorkSessionHttpBody(
  body: unknown,
): StartHandymanWorkSessionInput {
  const source = requireObjectBody(body);
  const details: Detail[] = [];
  collectUnknownFields(
    source,
    START_HANDYMAN_WORK_SESSION_HTTP_BODY_FIELDS,
    START_WORK_SESSION_PROTECTED_FIELDS,
    details,
  );
  const occurredAt = optionalOccurredAtField(source, details);
  const idempotencyKey = requireIdempotencyKeyField(source, details);
  if (details.length > 0) {
    fail(details);
  }
  return {
    occurredAt,
    idempotencyKey: idempotencyKey as string,
  };
}

/**
 * `POST /handyman-work-sessions/:sessionId/end` — no business body is
 * accepted (the Run-2 signature is `endHandymanWorkSession(sessionId,
 * actorUserId)`). An absent/empty JSON body is fine; ANY key (including
 * closure attribution, completion/QC or billing facts) is rejected with 400
 * VALIDATION_ERROR.
 */
export function assertEmptyEndWorkSessionHttpBody(body: unknown): void {
  if (body === undefined || body === null) return;
  const source = requireObjectBody(body);
  const details: Detail[] = [];
  collectUnknownFields(
    source,
    END_HANDYMAN_WORK_SESSION_HTTP_BODY_FIELDS,
    END_WORK_SESSION_PROTECTED_FIELDS,
    details,
  );
  if (details.length > 0) {
    fail(details);
  }
}
