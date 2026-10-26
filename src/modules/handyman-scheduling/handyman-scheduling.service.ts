import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { emitHandymanDomainNotificationIntent } from '../handyman-notifications/handyman-domain-notification.producer';
import { recordOperationalEvent } from '../operational-events';
import { buildingRepository } from '../buildings';
import { handymanServiceRequestNotFoundError } from '../handyman-requests/handyman-service-request.errors';
import { handymanServiceRequestRepository } from '../handyman-requests/handyman-service-request.repository';
import { handymanSchedulingReadinessRepository } from './handyman-scheduling.repository';
import {
  handymanSchedulingReadinessAlreadyExistsError,
  handymanSchedulingReadinessReasonInvalidError,
  handymanSchedulingReadinessInvalidStatusError,
  handymanSchedulingReadinessNotFoundError,
  handymanSchedulingReadinessTimezoneUnavailableError,
  handymanSchedulingReadinessWindowInvalidError,
} from './handyman-scheduling.errors';
import type {
  CreateHandymanSchedulingReadinessInput,
  HandymanSchedulingReadinessRecord,
  PublicHandymanSchedulingReadiness,
  SupersedeHandymanSchedulingReadinessInput,
  HandymanRequestedWindow,
} from './handyman-scheduling.types';

/**
 * CR-HM-05 PART 01 — Handyman Scheduling Readiness service (FROZEN
 * containment F1/F2/F7/F8/F9/F10).
 *
 * READINESS ONLY. This service never creates an execution schedule,
 * never binds a provider/crew, never reserves worker capacity, never
 * creates a job/work order/executionScopeId/targetId, and never
 * touches recurrence execution, attendance, work session or arrival
 * verification. clientId, building and timezone are SERVER-DERIVED from
 * the authoritative request → building chain; the caller supplies only
 * the request reference and the preferred window. Material changes
 * supersede rows atomically with append-only journal events; history is
 * never hard-deleted and is never lifecycle authority.
 */

function ensureUuid(value: string, field: string): void {
  const ok =
    typeof value === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
      .test(value.trim());
  if (!ok) {
    throw handymanSchedulingReadinessNotFoundError();
  }
}

/** PART 04: optional bounded scheduling-owned reason (no taxonomy). */
function ensureReason(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) return null;
  if (trimmed.length > 500) {
    throw handymanSchedulingReadinessReasonInvalidError();
  }
  return trimmed;
}

/** Strict window parse: valid instants and start strictly before end. */
function parseWindow(
  startRaw: string,
  endRaw: string,
): { start: Date; end: Date } {
  if (typeof startRaw !== 'string' || typeof endRaw !== 'string') {
    throw handymanSchedulingReadinessWindowInvalidError();
  }
  const start = new Date(startRaw.trim());
  const end = new Date(endRaw.trim());
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    throw handymanSchedulingReadinessWindowInvalidError();
  }
  return { start, end };
}

/** Timezone is ONLY ever derived from the authoritative building. */
async function deriveTimezone(buildingId: string): Promise<string> {
  const building = await buildingRepository.findById(buildingId);
  const timezone = building?.timezone?.trim();
  if (!building || !timezone) {
    throw handymanSchedulingReadinessTimezoneUnavailableError();
  }
  return timezone;
}

function toPublic(
  record: HandymanSchedulingReadinessRecord,
): PublicHandymanSchedulingReadiness {
  return {
    ...record,
    preferredWindowStart: record.preferredWindowStart.toISOString(),
    preferredWindowEnd: record.preferredWindowEnd.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isActiveUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return (
    e?.code === '23505' &&
    e?.constraint === 'handyman_sched_readiness_active_unique'
  );
}

/** Same existing insert + journal + notification, always on the caller's transaction. */
async function persistSchedulingReadiness(
  tx: PoolClient,
  input: CreateHandymanSchedulingReadinessInput,
  request: { id: string; clientId: string; buildingId: string },
  window: { start: Date; end: Date },
  timezone: string,
  actorUserId: string | null,
  provenance: Record<string, unknown> = {},
): Promise<PublicHandymanSchedulingReadiness> {
  const { start, end } = window;
  const journalBase = { clientId: request.clientId, actorUserId };
  const existing = await handymanSchedulingReadinessRepository
    .findActiveByRequest(tx, request.id);
  if (existing) throw handymanSchedulingReadinessAlreadyExistsError();

  const row = await handymanSchedulingReadinessRepository.insert(tx, {
    clientId: request.clientId,
    handymanRequestId: request.id,
    timezone,
    preferredWindowStart: start,
    preferredWindowEnd: end,
    supersedesReadinessId: null,
    changeReason: ensureReason(input.changeReason),
    createdByUserId: actorUserId,
  });
  await recordOperationalEvent(
    {
      ...journalBase,
      eventType: 'HANDYMAN_SCHEDULING_READINESS_CREATED',
      entityType: 'HANDYMAN_SCHEDULING_READINESS',
      entityId: row.id,
      summary: 'Handyman scheduling readiness created (ACTIVE).',
      metadata: {
        ...provenance,
        readinessId: row.id,
        handymanRequestId: request.id,
        buildingId: request.buildingId,
        timezone: row.timezone,
        preferredWindowStart: row.preferredWindowStart.toISOString(),
        preferredWindowEnd: row.preferredWindowEnd.toISOString(),
      },
    },
    tx,
  );
  // CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the notification
  // REACTION to the occurred scheduling readiness, on the SAME
  // transaction. The notification entity is the readiness OCCURRENCE.
  await emitHandymanDomainNotificationIntent(
    {
      eventType: 'HANDYMAN_SCHEDULING_READINESS_CREATED',
      clientId: request.clientId,
      entityId: row.id,
      buildingId: request.buildingId,
      variables: {
        handymanRequestId: request.id,
        readinessId: row.id,
        timezone: row.timezone,
        preferredWindowStart: row.preferredWindowStart.toISOString(),
        preferredWindowEnd: row.preferredWindowEnd.toISOString(),
        buildingId: request.buildingId,
      },
    },
    { executor: tx },
  );
  return toPublic(row);
}

/** Intake-only pair validation: explicit instants, never browser/server-local guesses.
 * Preference has no future-slot/booking/capacity semantics. */
export function parseOptionalHandymanRequestedWindow(
  startRaw: unknown, endRaw: unknown,
): HandymanRequestedWindow | undefined {
  if (startRaw === undefined && endRaw === undefined) return undefined;
  const validStamp = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(text) || text.startsWith('0000-')) return false;
    // Date.parse alone silently normalizes impossible dates such as February 30.
    const local = new Date(text.replace(/(?:Z|[+-]\d\d:\d\d)$/, 'Z'));
    return Number.isFinite(local.getTime()) && local.toISOString().slice(0, 19) === text.slice(0, 19);
  };
  if (!validStamp(startRaw) || !validStamp(endRaw)) throw handymanSchedulingReadinessWindowInvalidError();
  const { start, end } = parseWindow(startRaw, endRaw);
  return { preferredWindowStart: start.toISOString(), preferredWindowEnd: end.toISOString() };
}

/** INTERNAL Care-intake seam, not an HTTP authorization shortcut. Its callers
 * have already authorized creation and inserted the request on THIS transaction.
 * All scope, timezone and actor provenance are re-read from that request; the
 * actor is never taken from a body or substituted with a customer's User/PIC.
 */
export async function createInitialCareSchedulingReadiness(
  tx: PoolClient, requestId: string, input: HandymanRequestedWindow,
): Promise<PublicHandymanSchedulingReadiness> {
  const dates = parseOptionalHandymanRequestedWindow(input.preferredWindowStart, input.preferredWindowEnd);
  if (!dates) throw handymanSchedulingReadinessWindowInvalidError();
  const scope = (await tx.query<{
    id: string; clientId: string; buildingId: string; timezone: string | null;
    actorUserId: string | null; channelAttributionId: string;
    careActorId: string | null; actorReference: string | null;
  }>(`SELECT r.id, r.client_id AS "clientId", r.building_id AS "buildingId", b.timezone,
             r.created_by_user_id AS "actorUserId", a.id AS "channelAttributionId",
             a.care_actor_id AS "careActorId", a.actor_reference AS "actorReference"
        FROM handyman_service_requests r
        JOIN handyman_channel_attributions a ON a.id=r.channel_attribution_id
          AND a.client_id=r.client_id AND a.building_id=r.building_id
          AND a.created_by_user_id IS NOT DISTINCT FROM r.created_by_user_id
        JOIN buildings b ON b.id=r.building_id AND b.status='ACTIVE'
        JOIN properties p ON p.id=b.property_id AND p.client_id=r.client_id AND p.status='ACTIVE'
        JOIN clients c ON c.id=r.client_id AND c.status='ACTIVE'
       WHERE r.id=$1 AND r.status='INTAKE'
         AND ((r.origin_channel='CUSTOMER_CARE_BACKEND' AND r.created_by_user_id IS NOT NULL)
           OR (r.origin_channel='BM_SUPER_APP' AND r.created_by_user_id IS NULL
             AND a.actor_type='CUSTOMER_CARE' AND a.care_actor_id IS NOT NULL))
       FOR SHARE OF r,a,b,p,c`, [requestId])).rows[0];
  if (!scope) throw handymanServiceRequestNotFoundError();
  const timezone = scope.timezone?.trim();
  if (!timezone) throw handymanSchedulingReadinessTimezoneUnavailableError();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw handymanSchedulingReadinessTimezoneUnavailableError(); }
  return persistSchedulingReadiness(tx, { handymanRequestId: scope.id, ...dates }, scope,
    parseWindow(dates.preferredWindowStart, dates.preferredWindowEnd), timezone, scope.actorUserId, {
      channelAttributionId: scope.channelAttributionId,
      ...(scope.actorUserId === null ? { careActorId: scope.careActorId, actorReference: scope.actorReference } : {}),
    });
}

/**
 * Create the ACTIVE readiness fact for a request (one per request).
 * Atomic: row + CREATED journal event in ONE transaction; a concurrent
 * create loses the partial-UNIQUE race and surfaces as 409.
 */
export async function createHandymanSchedulingReadiness(
  input: CreateHandymanSchedulingReadinessInput,
  actorUserId: string,
): Promise<PublicHandymanSchedulingReadiness> {
  ensureUuid(input.handymanRequestId, 'handymanRequestId');
  ensureUuid(actorUserId, 'actorUserId');
  const { start, end } = parseWindow(
    input.preferredWindowStart,
    input.preferredWindowEnd,
  );

  const request = await handymanServiceRequestRepository.findById(
    undefined,
    input.handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  // CR-HM-SEC-02 PART 01 — BE-02G exact-Building guard on the
  // authoritative parent request chain (migration 0378: the request's
  // building_id is server-derived and NOT NULL), replacing the
  // client-level canAccessClient shortcut: a same-Client sibling
  // Building assignment must not open the write.
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });
  const timezone = await deriveTimezone(request.buildingId);

  try {
    return await withTransaction(async (tx) => {
      return persistSchedulingReadiness(tx, input, request, { start, end }, timezone, actorUserId);
    });
  } catch (error) {
    if (isActiveUniqueViolation(error)) {
      throw handymanSchedulingReadinessAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Material readiness change: supersede the ACTIVE row with a fresh
 * window. Atomic: old row → INACTIVE + SUPERSEDED event and new ACTIVE
 * row + CREATED event in ONE transaction. Timezone is re-derived from
 * the building authority — never accepted and never copied as input.
 */
export async function supersedeHandymanSchedulingReadiness(
  readinessId: string,
  input: SupersedeHandymanSchedulingReadinessInput,
  actorUserId: string,
): Promise<PublicHandymanSchedulingReadiness> {
  ensureUuid(readinessId, 'readinessId');
  ensureUuid(actorUserId, 'actorUserId');
  const { start, end } = parseWindow(
    input.preferredWindowStart,
    input.preferredWindowEnd,
  );

  try {
    return await withTransaction(async (tx) => {
      const current = await handymanSchedulingReadinessRepository.lockById(
        tx,
        readinessId,
      );
      if (!current) throw handymanSchedulingReadinessNotFoundError();
      const request = await handymanServiceRequestRepository.findById(
        tx,
        current.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();
      // CR-HM-SEC-02 PART 01 — BE-02G exact-Building guard on the
      // authoritative parent request chain, replacing the client-level
      // canAccessClient shortcut (wall position preserved: after the
      // readiness 404, before any mutation).
      await assertBuildingScopedResourceAccess(actorUserId, {
        clientId: current.clientId,
        buildingId: request.buildingId,
      });
      if (current.status !== 'ACTIVE') {
        throw handymanSchedulingReadinessInvalidStatusError();
      }
      const timezone = await deriveTimezone(request.buildingId);

      const superseded = await handymanSchedulingReadinessRepository
        .setStatus(tx, current.id, 'INACTIVE');
      if (!superseded) throw handymanSchedulingReadinessNotFoundError();
      const row = await handymanSchedulingReadinessRepository.insert(tx, {
        clientId: current.clientId,
        handymanRequestId: current.handymanRequestId,
        timezone,
        preferredWindowStart: start,
        preferredWindowEnd: end,
        supersedesReadinessId: current.id,
        changeReason: ensureReason(input.changeReason),
        createdByUserId: actorUserId,
      });

      const journalBase = { clientId: current.clientId, actorUserId };
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_SCHEDULING_READINESS_SUPERSEDED',
          entityType: 'HANDYMAN_SCHEDULING_READINESS',
          entityId: superseded.id,
          summary: 'Handyman scheduling readiness superseded (window change).',
          metadata: {
            readinessId: superseded.id,
            supersededByReadinessId: row.id,
            handymanRequestId: current.handymanRequestId,
            fromStatus: 'ACTIVE',
            toStatus: 'INACTIVE',
          },
        },
        tx,
      );
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_SCHEDULING_READINESS_CREATED',
          entityType: 'HANDYMAN_SCHEDULING_READINESS',
          entityId: row.id,
          summary: 'Handyman scheduling readiness created (ACTIVE, supersession).',
          metadata: {
            readinessId: row.id,
            supersedesReadinessId: superseded.id,
            handymanRequestId: current.handymanRequestId,
            timezone: row.timezone,
            preferredWindowStart: row.preferredWindowStart.toISOString(),
            preferredWindowEnd: row.preferredWindowEnd.toISOString(),
          },
        },
        tx,
      );
      // CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the notification
      // REACTION to the occurred scheduling readiness (the supersession path
      // writes a NEW ACTIVE readiness row — its own occurrence), on the SAME
      // transaction.
      await emitHandymanDomainNotificationIntent(
        {
          eventType: 'HANDYMAN_SCHEDULING_READINESS_CREATED',
          clientId: current.clientId,
          entityId: row.id,
          buildingId: request.buildingId,
          variables: {
            handymanRequestId: current.handymanRequestId,
            readinessId: row.id,
            timezone: row.timezone,
            preferredWindowStart: row.preferredWindowStart.toISOString(),
            preferredWindowEnd: row.preferredWindowEnd.toISOString(),
            buildingId: request.buildingId,
          },
        },
        { executor: tx },
      );
      return toPublic(row);
    });
  } catch (error) {
    if (isActiveUniqueViolation(error)) {
      throw handymanSchedulingReadinessAlreadyExistsError();
    }
    throw error;
  }
}

/** Bounded read: current ACTIVE fact + full preserved history. */
export async function getHandymanSchedulingReadiness(
  handymanRequestId: string,
  actorUserId?: string,
): Promise<{
  current: PublicHandymanSchedulingReadiness | null;
  history: PublicHandymanSchedulingReadiness[];
}> {
  ensureUuid(handymanRequestId, 'handymanRequestId');
  if (actorUserId !== undefined) ensureUuid(actorUserId, 'actorUserId');
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (actorUserId !== undefined) {
    // CR-HM-SEC-02 PART 01 — BE-02G exact-Building guard on the parent
    // request chain, replacing the client-level canAccessClient shortcut.
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: request.clientId,
      buildingId: request.buildingId,
    });
  }
  const current = await handymanSchedulingReadinessRepository
    .findActiveByRequest(undefined, request.id);
  const history = await handymanSchedulingReadinessRepository.listByRequest(
    undefined,
    request.id,
  );
  return {
    current: current ? toPublic(current) : null,
    history: history.map(toPublic),
  };
}

/**
 * PART 04 — bounded deterministic history read (rows are the lifecycle
 * authority): chronological by insertion (created_at ASC, id ASC);
 * ACTIVE/INACTIVE facts + row-level supersession links preserved.
 * Actor must hold existing Client/RBAC access for the request's client.
 */
export async function listHandymanSchedulingReadinessHistory(
  handymanRequestId: string,
  actorUserId: string,
): Promise<PublicHandymanSchedulingReadiness[]> {
  ensureUuid(handymanRequestId, 'handymanRequestId');
  ensureUuid(actorUserId, 'actorUserId');
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  // CR-HM-SEC-02 PART 01 — BE-02G exact-Building guard on the parent
  // request chain, replacing the client-level canAccessClient shortcut.
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });
  const rows = await handymanSchedulingReadinessRepository.listByRequest(
    undefined,
    request.id,
  );
  return rows.map(toPublic);
}

export const handymanSchedulingReadinessService = {
  createHandymanSchedulingReadiness,
  supersedeHandymanSchedulingReadiness,
  getHandymanSchedulingReadiness,
  listHandymanSchedulingReadinessHistory,
};
