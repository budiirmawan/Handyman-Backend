import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/**
 * CR-HM-BE-04 RUN 2 — Strict HTTP contract for Handyman Work Crew endpoints.
 * The transport layer accepts ONLY the allowlisted fields; every other key —
 * including protected server-derived fields — is rejected with 400
 * VALIDATION_ERROR details (the CR-HM-BE-02 RUN 3 idiom).
 *
 * Only transport shape is governed here. ALL business authority stays in the
 * Run 1 service: client/provider/vendor/worker validation, the EXTERNAL
 * profile rule, the lead invariant, lifecycle guards, and concurrency. No
 * Run-1 domain rule (crew-code pattern, binding status, role semantics) is
 * duplicated at the edge.
 */

type Detail = { field: string; message: string };

export const CREATE_HANDYMAN_WORK_CREW_HTTP_BODY_FIELDS = [
  'handymanProviderId',
  'crewCode',
  'crewName',
  'leadWorkerBindingId',
] as const;

export const UPDATE_HANDYMAN_WORK_CREW_HTTP_BODY_FIELDS = ['crewName'] as const;

export const LIST_HANDYMAN_WORK_CREWS_HTTP_QUERY_FIELDS = [
  'clientId',
  'handymanProviderId',
  'status',
] as const;

export const ADD_HANDYMAN_WORK_CREW_MEMBER_HTTP_BODY_FIELDS = [
  'vendorWorkforceBindingId',
  'crewRole',
] as const;

export const LIST_HANDYMAN_WORK_CREW_MEMBERS_HTTP_QUERY_FIELDS = [
  'status',
] as const;

export const CHANGE_HANDYMAN_WORK_CREW_LEAD_HTTP_BODY_FIELDS = [
  'newLeadWorkerBindingId',
] as const;

const CREW_ROLE_VALUES = new Set(['LEAD_WORKER', 'HELPER']);
const CREW_STATUS_VALUES = new Set(['ACTIVE', 'INACTIVE']);

/** Protected crew-creation fields: server-derived, never accepted. */
const CREATE_HANDYMAN_WORK_CREW_PROTECTED_FIELDS: Record<string, string> = {
  clientId:
    'Client id is derived server-side from the handyman provider designation and is not accepted in the body.',
  status: 'Status is server-managed; a crew is created ACTIVE.',
  createdByUserId: 'Created-by identity comes from the authenticated actor.',
  updatedByUserId: 'Updated-by identity comes from the authenticated actor.',
  id: 'Crew id is server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
  buildingId: 'Work crews carry no building assignment (CR-HM-BE-04 boundary).',
  requestId: 'Crew-to-request assignment does not exist (CR-HM-BE-04 boundary).',
  workOrderId: 'Crew-to-work-order assignment does not exist (CR-HM-BE-04 boundary).',
  vendorId:
    'The provider vendor is derived from the handyman provider designation and is not accepted in the body.',
  members: 'Members are seated through the governed member endpoints only.',
  leadWorkerMemberId: 'The founding lead membership is server-generated.',
};

/** Protected crew-update fields (only mutable metadata `crewName` allowed). */
const UPDATE_HANDYMAN_WORK_CREW_PROTECTED_FIELDS: Record<string, string> = {
  crewCode: 'Crew code is immutable identity and cannot be changed.',
  handymanProviderId: 'Provider identity is immutable after creation.',
  clientId: 'Client id is immutable after creation.',
  status:
    'Status changes use the governed activate/deactivate commands, never PATCH.',
  createdByUserId: 'Audit stamps are server-managed.',
  updatedByUserId: 'Audit stamps are server-managed.',
  id: 'Crew id is server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
  leadWorkerBindingId:
    'Lead identity changes use the governed atomic lead-change command, never PATCH.',
};

/** Protected member-add fields. */
const ADD_HANDYMAN_WORK_CREW_MEMBER_PROTECTED_FIELDS: Record<string, string> = {
  clientId: 'Client id is derived from the crew and is not accepted.',
  crewId: 'Crew id comes from the route and is not accepted in the body.',
  status: 'Membership status is server-managed; a membership is created ACTIVE.',
  addedByUserId: 'Added-by identity comes from the authenticated actor.',
  removedByUserId: 'Removal attribution comes from the governed remove command.',
  id: 'Membership id is server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
  addedAt: 'Timestamps are server-generated.',
  removedAt: 'Timestamps are server-generated.',
  effectiveFrom: 'The effective window is server-managed.',
  effectiveTo: 'The effective window is server-managed.',
  userId: 'Crew membership never creates or links a user account.',
};

/** Protected lead-change fields: the outgoing lead is derived server-side. */
const CHANGE_HANDYMAN_WORK_CREW_LEAD_PROTECTED_FIELDS: Record<string, string> = {
  oldLeadMemberId:
    'The outgoing lead membership is derived server-side from the crew active lead.',
  previousMemberId:
    'The outgoing lead membership is derived server-side from the crew active lead.',
  currentLeadMemberId:
    'The outgoing lead membership is derived server-side from the crew active lead.',
  leadWorkerBindingId:
    'Use newLeadWorkerBindingId; the outgoing lead is derived server-side.',
  crewId: 'Crew id comes from the route and is not accepted in the body.',
  clientId: 'Client id is derived from the crew and is not accepted.',
  handymanProviderId: 'Provider identity is immutable and server-derived.',
  crewRole: 'The replacement membership role is always LEAD_WORKER.',
  status: 'Membership status is server-managed.',
  addedByUserId: 'Audit identity comes from the authenticated actor.',
  removedByUserId: 'Audit identity comes from the authenticated actor.',
  id: 'Membership ids are server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

/** Protected fields on bodyless governed commands (activate/deactivate/remove). */
const EMPTY_COMMAND_PROTECTED_FIELDS: Record<string, string> = {
  status: 'The target status is fixed by the command route.',
  crewRole: 'Role is not an input to this command.',
  clientId: 'Client id is server-derived.',
  crewId: 'Crew id comes from the route.',
  memberId: 'Member id comes from the route.',
  removedByUserId: 'Removal attribution comes from the authenticated actor.',
  updatedByUserId: 'Audit identity comes from the authenticated actor.',
  reason: 'No reason field exists on this command.',
  notes: 'No notes field exists on this command.',
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
    if (!(allowed as readonly string[]).includes(field)) {
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
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!isValidUuid(normalized)) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return null;
  }
  return normalized;
}

function requireNonEmptyStringField(
  source: Record<string, unknown>,
  field: string,
  label: string,
  details: Detail[],
): string | null {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return null;
  }
  return value.trim();
}

/** `:crewId` path segment → normalized lowercase UUID. */
export function parseHandymanWorkCrewIdParam(raw: string): string {
  return parseUuidParam(raw, 'crewId', 'Crew id');
}

/** `:memberId` path segment → normalized lowercase UUID. */
export function parseHandymanWorkCrewMemberIdParam(raw: string): string {
  return parseUuidParam(raw, 'memberId', 'Member id');
}

/**
 * `POST /handyman-work-crews` body → the four business inputs of the Run-1
 * atomic founding-lead creation. `clientId` is NEVER accepted: the crew
 * service derives it from the provider designation and re-asserts every
 * Run-1 invariant (client access, ACTIVE designation, ACTIVE vendor, valid
 * EXTERNAL founding lead).
 */
export function parseCreateHandymanWorkCrewHttpBody(body: unknown): {
  handymanProviderId: string;
  crewCode: string;
  crewName: string;
  leadWorkerBindingId: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(
    body,
    CREATE_HANDYMAN_WORK_CREW_HTTP_BODY_FIELDS,
    CREATE_HANDYMAN_WORK_CREW_PROTECTED_FIELDS,
    details,
  );

  const handymanProviderId = requireUuidField(
    body,
    'handymanProviderId',
    'Handyman provider id',
    details,
  );
  const leadWorkerBindingId = requireUuidField(
    body,
    'leadWorkerBindingId',
    'Lead worker binding id',
    details,
  );
  const crewCode = requireNonEmptyStringField(
    body,
    'crewCode',
    'Crew code',
    details,
  );
  const crewName = requireNonEmptyStringField(
    body,
    'crewName',
    'Crew name',
    details,
  );

  if (details.length > 0) {
    fail(details);
  }

  return {
    handymanProviderId: handymanProviderId as string,
    crewCode: crewCode as string,
    crewName: crewName as string,
    leadWorkerBindingId: leadWorkerBindingId as string,
  };
}

/** `PATCH /handyman-work-crews/:crewId` body → `{ crewName }` ONLY. */
export function parseUpdateHandymanWorkCrewHttpBody(body: unknown): {
  crewName: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(
    body,
    UPDATE_HANDYMAN_WORK_CREW_HTTP_BODY_FIELDS,
    UPDATE_HANDYMAN_WORK_CREW_PROTECTED_FIELDS,
    details,
  );

  const crewName = requireNonEmptyStringField(
    body,
    'crewName',
    'Crew name',
    details,
  );

  if (details.length > 0) {
    fail(details);
  }

  return { crewName: crewName as string };
}

/**
 * `GET /handyman-work-crews` query → `{ clientId, handymanProviderId?,
 * status? }`. `clientId` is required transport scoping; whether the actor may
 * see that client is decided ONLY by the Run-1 service (context-access
 * authority) — the edge performs no access logic.
 */
export function parseListHandymanWorkCrewsHttpQuery(query: unknown): {
  clientId: string;
  handymanProviderId?: string;
  status?: 'ACTIVE' | 'INACTIVE';
} {
  if (!isRecord(query)) {
    fail([{ field: 'query', message: 'Query must be a set of parameters.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(query, LIST_HANDYMAN_WORK_CREWS_HTTP_QUERY_FIELDS, {}, details);

  const clientId = requireUuidField(query, 'clientId', 'Client id', details);

  let handymanProviderId: string | undefined;
  if (query.handymanProviderId !== undefined) {
    const parsed = requireUuidField(
      query,
      'handymanProviderId',
      'Handyman provider id',
      details,
    );
    handymanProviderId = parsed ?? undefined;
  }

  let status: 'ACTIVE' | 'INACTIVE' | undefined;
  if (query.status !== undefined) {
    if (
      typeof query.status !== 'string' ||
      !CREW_STATUS_VALUES.has(query.status.trim().toUpperCase())
    ) {
      details.push({
        field: 'status',
        message: 'Status must be ACTIVE or INACTIVE.',
      });
    } else {
      status = query.status.trim().toUpperCase() as 'ACTIVE' | 'INACTIVE';
    }
  }

  if (details.length > 0) {
    fail(details);
  }

  return {
    clientId: clientId as string,
    ...(handymanProviderId ? { handymanProviderId } : {}),
    ...(status ? { status } : {}),
  };
}

/**
 * `POST /handyman-work-crews/:crewId/members` body → `{
 * vendorWorkforceBindingId, crewRole }`. `crewRole` is wire vocabulary only;
 * the lead invariant and worker validation stay in the Run-1 service.
 */
export function parseAddHandymanWorkCrewMemberHttpBody(body: unknown): {
  vendorWorkforceBindingId: string;
  crewRole: 'LEAD_WORKER' | 'HELPER';
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(
    body,
    ADD_HANDYMAN_WORK_CREW_MEMBER_HTTP_BODY_FIELDS,
    ADD_HANDYMAN_WORK_CREW_MEMBER_PROTECTED_FIELDS,
    details,
  );

  const vendorWorkforceBindingId = requireUuidField(
    body,
    'vendorWorkforceBindingId',
    'Vendor workforce binding id',
    details,
  );

  let crewRole: 'LEAD_WORKER' | 'HELPER' | null = null;
  if (
    typeof body.crewRole !== 'string' ||
    !CREW_ROLE_VALUES.has(body.crewRole.trim().toUpperCase())
  ) {
    details.push({
      field: 'crewRole',
      message: 'Crew role must be LEAD_WORKER or HELPER.',
    });
  } else {
    crewRole = body.crewRole.trim().toUpperCase() as 'LEAD_WORKER' | 'HELPER';
  }

  if (details.length > 0) {
    fail(details);
  }

  return {
    vendorWorkforceBindingId: vendorWorkforceBindingId as string,
    crewRole: crewRole as 'LEAD_WORKER' | 'HELPER',
  };
}

/** `GET /handyman-work-crews/:crewId/members` query → optional status filter. */
export function parseListHandymanWorkCrewMembersHttpQuery(query: unknown): {
  status?: 'ACTIVE' | 'INACTIVE';
} {
  if (!isRecord(query)) {
    fail([{ field: 'query', message: 'Query must be a set of parameters.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(query, LIST_HANDYMAN_WORK_CREW_MEMBERS_HTTP_QUERY_FIELDS, {}, details);

  let status: 'ACTIVE' | 'INACTIVE' | undefined;
  if (query.status !== undefined) {
    if (
      typeof query.status !== 'string' ||
      !CREW_STATUS_VALUES.has(query.status.trim().toUpperCase())
    ) {
      details.push({
        field: 'status',
        message: 'Status must be ACTIVE or INACTIVE.',
      });
    } else {
      status = query.status.trim().toUpperCase() as 'ACTIVE' | 'INACTIVE';
    }
  }

  if (details.length > 0) {
    fail(details);
  }

  return status ? { status } : {};
}

/**
 * `POST /handyman-work-crews/:crewId/lead-worker/change` body →
 * `{ newLeadWorkerBindingId }` ONLY. The outgoing lead is derived
 * server-side by the Run-1 atomic command; supplying any derivation input
 * (old lead id, role, status, client/provider, audit fields) is rejected.
 */
export function parseChangeHandymanWorkCrewLeadHttpBody(body: unknown): {
  newLeadWorkerBindingId: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];
  collectUnknownFields(
    body,
    CHANGE_HANDYMAN_WORK_CREW_LEAD_HTTP_BODY_FIELDS,
    CHANGE_HANDYMAN_WORK_CREW_LEAD_PROTECTED_FIELDS,
    details,
  );

  const newLeadWorkerBindingId = requireUuidField(
    body,
    'newLeadWorkerBindingId',
    'New lead worker binding id',
    details,
  );

  if (details.length > 0) {
    fail(details);
  }

  return { newLeadWorkerBindingId: newLeadWorkerBindingId as string };
}

/**
 * Bodyless governed commands (`activate`, `deactivate`, member `remove`):
 * the route IS the command, so any body key is rejected — nothing about the
 * transition is caller-authoritative.
 */
export function assertEmptyHandymanWorkCrewCommandBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be empty.' }]);
  }
  const keys = Object.keys(body);
  if (keys.length === 0) {
    return;
  }
  const details: Detail[] = keys.map((field) => ({
    field,
    message:
      EMPTY_COMMAND_PROTECTED_FIELDS[field] ??
      'This command accepts no body fields.',
  }));
  fail(details);
}
