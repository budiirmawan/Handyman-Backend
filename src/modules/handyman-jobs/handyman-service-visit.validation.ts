import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/**
 * CR-HM-BE-05 RUN 3 — Strict HTTP contract for the Handyman Service Visit
 * scheduling endpoints. The transport layer accepts ONLY the allowlisted
 * business facts of the EXISTING Run-2 service commands (planned window
 * timestamps, and NOTHING for cancel); every other key — including protected
 * server-derived authority (client, job/visit identity, sequence, schedule
 * lifecycle/attribution fields) and every out-of-scope execution field
 * (arrival, GPS, QR, check-in, session, labor) — is rejected with 400
 * VALIDATION_ERROR details. Timestamps are validated as TRANSPORT SHAPE
 * (parseable ISO-8601 date-time → Date); the domain remains responsible for
 * end > start, lifecycle and conflict semantics.
 */

type Detail = { field: string; message: string };

export const CREATE_HANDYMAN_SERVICE_VISIT_HTTP_BODY_FIELDS = [
  'plannedStartAt',
  'plannedEndAt',
] as const;

export const RESCHEDULE_HANDYMAN_SERVICE_VISIT_HTTP_BODY_FIELDS = [
  'plannedStartAt',
  'plannedEndAt',
] as const;

/** The cancel command carries NO business body (the Run-2 signature is
 * `cancelHandymanServiceVisitSchedule(visitId, actorUserId)`). */
export const CANCEL_HANDYMAN_SERVICE_VISIT_HTTP_BODY_FIELDS = [] as const;

/** Protected fields on visit creation: server-derived, never accepted. */
const CREATE_HANDYMAN_SERVICE_VISIT_PROTECTED_FIELDS: Record<string, string> = {
  clientId: 'Client id is derived server-side from the job.',
  handymanJobId: 'Job id comes from the route.',
  jobId: 'Job id comes from the route.',
  visitSequence: 'Visit sequence is server-generated under a job-row lock.',
  visitId: 'Visit id is server-generated.',
  scheduleId: 'Schedule id is server-generated.',
  status: 'Schedule lifecycle is server-managed (ACTIVE/SUPERSEDED/CANCELLED).',
  createdByUserId: 'Created-by identity comes from the authenticated actor.',
  supersededAt: 'Closure attribution is server-managed.',
  supersededByUserId: 'Closure attribution is server-managed.',
  cancelledAt: 'Closure attribution is server-managed.',
  cancelledByUserId: 'Closure attribution is server-managed.',
  id: 'Ids are server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
  permitRequirementType: 'Permit readiness stays on the existing BE-15D authority.',
  arrivalAt: 'Arrival/check-in execution facts do not exist in CR-HM-BE-05.',
  checkedInAt: 'Arrival/check-in execution facts do not exist in CR-HM-BE-05.',
  gps: 'Location capture does not exist in CR-HM-BE-05.',
  qrCode: 'QR surfaces do not exist in CR-HM-BE-05.',
  workSessionId: 'WorkSession execution does not exist in CR-HM-BE-05.',
};

/** Protected fields on reschedule (identical wire allowlist; identity and
 * closure attribution are server-managed). */
const RESCHEDULE_HANDYMAN_SERVICE_VISIT_PROTECTED_FIELDS: Record<string, string> =
  {
    ...CREATE_HANDYMAN_SERVICE_VISIT_PROTECTED_FIELDS,
    visitId: 'Visit id comes from the route.',
    supersededScheduleId: 'The superseded schedule is derived server-side from the visit’s ACTIVE window.',
  };

/** Protected fields on cancel: the command accepts no business facts. */
const CANCEL_HANDYMAN_SERVICE_VISIT_PROTECTED_FIELDS: Record<string, string> = {
  visitId: 'Visit id comes from the route.',
  scheduleId: 'The ACTIVE schedule is derived server-side.',
  reason: 'Cancellation carries no business body; attribution is server-managed.',
  cancelledByUserId: 'Cancelled-by identity comes from the authenticated actor.',
  cancelledAt: 'Timestamps are server-generated.',
  status: 'Schedule lifecycle is server-managed.',
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

/**
 * One planned-window timestamp: required, ISO-8601 date-time string on the
 * wire, normalized to a Date for the Run-2 command. Ordering (end > start)
 * and every lifecycle/conflict rule stay in the domain.
 */
function requireTimestampField(
  source: Record<string, unknown>,
  field: string,
  label: string,
  details: Detail[],
): Date | null {
  const raw = source[field];
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return null;
  }
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    details.push({
      field,
      message: `${label} must be a valid ISO-8601 date-time.`,
    });
    return null;
  }
  return parsed;
}

/** `:visitId` path segment → normalized lowercase UUID. */
export function parseHandymanServiceVisitIdParam(raw: string): string {
  return parseUuidParam(raw, 'visitId', 'Service visit id');
}

function parsePlannedWindowBody(
  body: unknown,
  allowed: readonly string[],
  protectedFields: Record<string, string>,
): { plannedStartAt: Date; plannedEndAt: Date } {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(body, allowed, protectedFields, details);
  const plannedStartAt = requireTimestampField(
    body,
    'plannedStartAt',
    'Planned start',
    details,
  );
  const plannedEndAt = requireTimestampField(
    body,
    'plannedEndAt',
    'Planned end',
    details,
  );

  if (details.length > 0) {
    fail(details);
  }

  return {
    plannedStartAt: plannedStartAt as Date,
    plannedEndAt: plannedEndAt as Date,
  };
}

/**
 * `POST /handyman-jobs/:jobId/visits` body → `{ plannedStartAt,
 * plannedEndAt }`. The job comes from the route; the visit identity,
 * sequence and first ACTIVE schedule are composed by the Run-2 service.
 */
export function parseCreateHandymanServiceVisitHttpBody(body: unknown): {
  plannedStartAt: Date;
  plannedEndAt: Date;
} {
  return parsePlannedWindowBody(
    body,
    CREATE_HANDYMAN_SERVICE_VISIT_HTTP_BODY_FIELDS,
    CREATE_HANDYMAN_SERVICE_VISIT_PROTECTED_FIELDS,
  );
}

/**
 * `POST /handyman-service-visits/:visitId/reschedule` body → `{
 * plannedStartAt, plannedEndAt }`. The superseded window is derived
 * server-side and never mutated.
 */
export function parseRescheduleHandymanServiceVisitHttpBody(body: unknown): {
  plannedStartAt: Date;
  plannedEndAt: Date;
} {
  return parsePlannedWindowBody(
    body,
    RESCHEDULE_HANDYMAN_SERVICE_VISIT_HTTP_BODY_FIELDS,
    RESCHEDULE_HANDYMAN_SERVICE_VISIT_PROTECTED_FIELDS,
  );
}

/**
 * `POST /handyman-service-visits/:visitId/cancel` — no business body is
 * accepted. An absent/empty JSON body is fine; ANY key (including protected
 * closure attribution) is rejected with 400 VALIDATION_ERROR.
 */
export function assertEmptyCancelHandymanServiceVisitHttpBody(
  body: unknown,
): void {
  if (body === undefined || body === null) return;
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  collectUnknownFields(
    body,
    CANCEL_HANDYMAN_SERVICE_VISIT_HTTP_BODY_FIELDS,
    CANCEL_HANDYMAN_SERVICE_VISIT_PROTECTED_FIELDS,
    details,
  );
  if (details.length > 0) {
    fail(details);
  }
}
