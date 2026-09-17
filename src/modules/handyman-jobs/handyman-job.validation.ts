import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/**
 * CR-HM-BE-05 RUN 3 — Strict HTTP contract for the Handyman Job + job
 * assignment endpoints. The transport layer accepts ONLY the allowlisted
 * business facts of the EXISTING Run-1 service commands; every other key —
 * including protected server-derived authority (client, work order, status,
 * building context, vendor composition ids, actor/timestamp attribution) —
 * is rejected with 400 VALIDATION_ERROR details. All business authority
 * (request approval state, idempotency, time-of-use eligibility, atomic
 * BE-15A/BE-15B composition, pre-execution reassignment guards) stays in the
 * Run-1 service; this module only governs the wire shape.
 */

type Detail = { field: string; message: string };

export const CREATE_HANDYMAN_JOB_HTTP_BODY_FIELDS = ['handymanRequestId'] as const;

export const ASSIGN_HANDYMAN_JOB_HTTP_BODY_FIELDS = [
  'handymanProviderId',
  'handymanWorkCrewId',
] as const;

export const LIST_HANDYMAN_JOBS_HTTP_QUERY_FIELDS = [
  'clientId',
  'handymanRequestId',
  'workOrderId',
] as const;

/** Protected fields on job creation: server-derived, never accepted. */
const CREATE_HANDYMAN_JOB_PROTECTED_FIELDS: Record<string, string> = {
  clientId: 'Client id is derived server-side from the approved request.',
  workOrderId: 'The work order is created and bound by the Run-1 service.',
  workOrderNumber: 'The work order number is server-generated.',
  status: 'Handyman jobs have no independent lifecycle status; the work order owns it.',
  buildingId: 'Building context is derived server-side from the request/work order.',
  spaceId: 'Space context is derived server-side from the request/work order.',
  handymanProviderId: 'Provider composition uses the governed assignment command.',
  vendorId: 'Vendor composition is derived server-side from the provider designation.',
  vendorAssignmentId: 'The BE-15A assignment row is composed by the Run-1 service.',
  vendorWorkId: 'The BE-15B vendor work row is composed by the Run-1 service.',
  handymanWorkCrewId: 'Crew composition uses the governed assignment command.',
  createdByUserId: 'Created-by identity comes from the authenticated actor.',
  id: 'Job id is server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
  plannedStartAt: 'Scheduling uses the governed service-visit commands.',
  plannedEndAt: 'Scheduling uses the governed service-visit commands.',
};

/** Protected fields on assignment/reassignment (composition bodies). */
const ASSIGN_HANDYMAN_JOB_PROTECTED_FIELDS: Record<string, string> = {
  jobId: 'Job id comes from the route.',
  handymanJobId: 'Job id comes from the route.',
  vendorId: 'Vendor id is derived server-side from the provider designation.',
  vendorAssignmentId: 'The BE-15A assignment row is composed by the Run-1 service.',
  vendorWorkId: 'The BE-15B vendor work row is composed by the Run-1 service.',
  clientId: 'Client id is derived server-side from the job.',
  workOrderId: 'Work order authority comes from the job; it is never caller-supplied.',
  status: 'Assignment lifecycle is server-managed (ACTIVE/SUPERSEDED guards live in the Run-1 service).',
  assignedByUserId: 'Assignment attribution comes from the authenticated actor.',
  assignedBy: 'Assignment attribution comes from the authenticated actor.',
  supersededByUserId: 'Supersede attribution is server-managed.',
  supersededBy: 'Supersede attribution is server-managed.',
  assignedAt: 'Timestamps are server-generated.',
  supersededAt: 'Timestamps are server-generated.',
  effectiveFrom: 'Effective timing is server-generated.',
  effectiveAt: 'Effective timing is server-generated.',
  id: 'Assignment id is server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
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

function requireUuidField(
  source: Record<string, unknown>,
  field: string,
  label: string,
  details: Detail[],
): string | null {
  const raw = source[field];
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return null;
  }
  return value;
}

/** `:jobId` path segment → normalized lowercase UUID. */
export function parseHandymanJobIdParam(raw: string): string {
  return parseUuidParam(raw, 'jobId', 'Job id');
}

/**
 * `POST /handyman-jobs` body → `{ handymanRequestId }`. The Run-1 command
 * takes exactly this one business fact; everything else (client, work order,
 * quotation revision binding) is resolved server-side.
 */
export function parseCreateHandymanJobHttpBody(body: unknown): {
  handymanRequestId: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(
    body,
    CREATE_HANDYMAN_JOB_HTTP_BODY_FIELDS,
    CREATE_HANDYMAN_JOB_PROTECTED_FIELDS,
    details,
  );
  const handymanRequestId = requireUuidField(
    body,
    'handymanRequestId',
    'Handyman request id',
    details,
  );

  if (details.length > 0) {
    fail(details);
  }

  return { handymanRequestId: handymanRequestId as string };
}

/**
 * `POST /handyman-jobs/:jobId/assignment` (and `/assignment/reassign`) body
 * → `{ handymanProviderId, handymanWorkCrewId }`. The Run-1 service remains
 * authoritative for every time-of-use check and for composing the BE-15A/
 * BE-15B rows; the controller never composes them itself.
 */
export function parseAssignHandymanJobHttpBody(body: unknown): {
  handymanProviderId: string;
  handymanWorkCrewId: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(
    body,
    ASSIGN_HANDYMAN_JOB_HTTP_BODY_FIELDS,
    ASSIGN_HANDYMAN_JOB_PROTECTED_FIELDS,
    details,
  );
  const handymanProviderId = requireUuidField(
    body,
    'handymanProviderId',
    'Handyman provider id',
    details,
  );
  const handymanWorkCrewId = requireUuidField(
    body,
    'handymanWorkCrewId',
    'Handyman work crew id',
    details,
  );

  if (details.length > 0) {
    fail(details);
  }

  return {
    handymanProviderId: handymanProviderId as string,
    handymanWorkCrewId: handymanWorkCrewId as string,
  };
}

/**
 * `GET /handyman-jobs` query → `{ clientId, handymanRequestId?,
 * workOrderId? }`. `clientId` is required transport scoping (the domain list
 * read is client-scoped); the two optional filters are EXACTLY the domain
 * `HandymanJobFilters`. Whether the actor may see that client is decided
 * ONLY by the Run-1 service through the existing context-access authority —
 * the edge performs no access logic.
 */
export function parseListHandymanJobsHttpQuery(query: unknown): {
  clientId: string;
  handymanRequestId?: string;
  workOrderId?: string;
} {
  if (!isRecord(query)) {
    fail([{ field: 'query', message: 'Query must be a set of parameters.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(query, LIST_HANDYMAN_JOBS_HTTP_QUERY_FIELDS, {}, details);

  const clientId = requireUuidField(query, 'clientId', 'Client id', details);

  let handymanRequestId: string | undefined;
  if (query.handymanRequestId !== undefined) {
    const parsed = requireUuidField(
      query,
      'handymanRequestId',
      'Handyman request id',
      details,
    );
    handymanRequestId = parsed ?? undefined;
  }

  let workOrderId: string | undefined;
  if (query.workOrderId !== undefined) {
    const parsed = requireUuidField(
      query,
      'workOrderId',
      'Work order id',
      details,
    );
    workOrderId = parsed ?? undefined;
  }

  if (details.length > 0) {
    fail(details);
  }

  return {
    clientId: clientId as string,
    ...(handymanRequestId ? { handymanRequestId } : {}),
    ...(workOrderId ? { workOrderId } : {}),
  };
}
