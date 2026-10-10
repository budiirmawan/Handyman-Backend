import { withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { buildingRepository } from '../buildings';
import {
  handymanServiceRequestNotFoundError,
  handymanServiceRequestRepository,
} from '../handyman-requests';
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

  const journalBase = { clientId: request.clientId, actorUserId };
  try {
    return await withTransaction(async (tx) => {
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
      return toPublic(row);
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
