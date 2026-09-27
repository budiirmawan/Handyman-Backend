import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { areaRepository } from '../areas';
import { floorRepository } from '../floors';
import { roomRepository } from '../rooms';
import { spaceRepository } from '../spaces';
import {
  handymanServiceRequestNotFoundError,
  handymanServiceRequestRepository,
} from '../handyman-requests';
import { handymanUnitAccessReadinessRepository } from './handyman-unit-access.repository';
import {
  handymanUnitAccessReadinessAlreadyExistsError,
  handymanUnitAccessReadinessInvalidStatusError,
  handymanUnitAccessReadinessLocationInconsistentError,
  handymanUnitAccessReadinessNotFoundError,
  handymanUnitAccessReadinessUnitSpaceUnavailableError,
  handymanUnitAccessReadinessWindowInvalidError,
} from './handyman-unit-access.errors';
import type {
  CreateHandymanUnitAccessReadinessInput,
  HandymanUnitAccessReadinessRecord,
  PublicHandymanUnitAccessReadiness,
  SupersedeHandymanUnitAccessReadinessInput,
} from './handyman-unit-access.types';

/**
 * CR-HM-05 PART 02 — Handyman Unit Access Readiness service (FROZEN
 * containment F5/F6/F7/F8/F9/F10).
 *
 * AUTHORIZATION/READINESS ONLY: never arrival verification, never
 * physical check-in, QR/challenge, geofence/risk, visitor arrival,
 * attendance, work session, permit readiness or execution scheduling —
 * and CR-HM-07 remains the exclusive owner of physical arrival proof.
 * ALL location references are SERVER-DERIVED from the authoritative
 * request snapshot + location-master chain; the caller supplies only
 * the request reference, the access window and the authorization note.
 * Material changes supersede rows atomically with append-only journal
 * events; history is never hard-deleted and is never lifecycle
 * authority. No permit runtime (PART 03), no provider/crew binding, no
 * execution target, no FM work order exists or is referenced here.
 */

function ensureUuid(value: string, field: string): void {
  const ok =
    typeof value === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
      .test(value.trim());
  if (!ok) {
    throw handymanUnitAccessReadinessNotFoundError();
  }
}

/** Strict window parse: valid instants and start strictly before end. */
function parseWindow(
  startRaw: string,
  endRaw: string,
): { start: Date; end: Date } {
  if (typeof startRaw !== 'string' || typeof endRaw !== 'string') {
    throw handymanUnitAccessReadinessWindowInvalidError();
  }
  const start = new Date(startRaw.trim());
  const end = new Date(endRaw.trim());
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    throw handymanUnitAccessReadinessWindowInvalidError();
  }
  return { start, end };
}

function ensureNote(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 1 || trimmed.length > 1000) {
    throw handymanUnitAccessReadinessWindowInvalidError();
  }
  return trimmed;
}

/**
 * Derive the authoritative location chain: request.spaceId → space →
 * room → area → floor → building. The derived building MUST equal the
 * request's snapshot building (caller redirection is impossible; F5/F7).
 * A request without an authoritative unit/space is a bounded rejection —
 * never an invented location. Exported for CR-HM-05 PART 03 (permit
 * readiness must follow the identical derivation).
 */
export async function deriveHandymanLocationChain(request: {
  buildingId: string;
  spaceId: string | null;
}): Promise<{
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string;
}> {
  const spaceId = request.spaceId;
  if (!spaceId) throw handymanUnitAccessReadinessUnitSpaceUnavailableError();
  const space = await spaceRepository.findById(spaceId);
  if (!space) throw handymanUnitAccessReadinessUnitSpaceUnavailableError();
  const room = await roomRepository.findById(space.roomId);
  if (!room) throw handymanUnitAccessReadinessUnitSpaceUnavailableError();
  const area = await areaRepository.findById(room.areaId);
  if (!area) throw handymanUnitAccessReadinessUnitSpaceUnavailableError();
  const floor = await floorRepository.findById(area.floorId);
  if (!floor) throw handymanUnitAccessReadinessUnitSpaceUnavailableError();
  if (floor.buildingId !== request.buildingId) {
    throw handymanUnitAccessReadinessLocationInconsistentError();
  }
  return {
    buildingId: floor.buildingId,
    floorId: floor.id,
    areaId: area.id,
    roomId: room.id,
    spaceId: space.id,
  };
}

function toPublic(
  record: HandymanUnitAccessReadinessRecord,
): PublicHandymanUnitAccessReadiness {
  return {
    ...record,
    accessWindowStart: record.accessWindowStart.toISOString(),
    accessWindowEnd: record.accessWindowEnd.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isActiveUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return (
    e?.code === '23505' &&
    e?.constraint === 'handyman_access_readiness_active_unique'
  );
}

/**
 * Create the ACTIVE access-readiness fact for a request (one per
 * request). Atomic: row + CREATED journal event in ONE transaction; a
 * concurrent create loses the partial-UNIQUE race and surfaces as 409.
 */
export async function createHandymanUnitAccessReadiness(
  input: CreateHandymanUnitAccessReadinessInput,
  actorUserId: string,
): Promise<PublicHandymanUnitAccessReadiness> {
  ensureUuid(input.handymanRequestId, 'handymanRequestId');
  ensureUuid(actorUserId, 'actorUserId');
  const { start, end } = parseWindow(
    input.accessWindowStart,
    input.accessWindowEnd,
  );
  const authorizationNote = ensureNote(input.authorizationNote);

  const request = await handymanServiceRequestRepository.findById(
    undefined,
    input.handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (!(await contextAccessService.canAccessClient(actorUserId, request.clientId))) {
    throw buildingAccessDeniedError();
  }
  const location = await deriveHandymanLocationChain(request);

  const journalBase = { clientId: request.clientId, actorUserId };
  try {
    return await withTransaction(async (tx) => {
      const existing = await handymanUnitAccessReadinessRepository
        .findActiveByRequest(tx, request.id);
      if (existing) throw handymanUnitAccessReadinessAlreadyExistsError();

      const row = await handymanUnitAccessReadinessRepository.insert(tx, {
        clientId: request.clientId,
        handymanRequestId: request.id,
        ...location,
        accessWindowStart: start,
        accessWindowEnd: end,
        authorizationNote,
        supersedesReadinessId: null,
        authorizedByUserId: actorUserId,
      });
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
          entityType: 'HANDYMAN_UNIT_ACCESS_READINESS',
          entityId: row.id,
          summary: 'Handyman unit access readiness created (ACTIVE).',
          metadata: {
            readinessId: row.id,
            handymanRequestId: request.id,
            buildingId: location.buildingId,
            floorId: location.floorId,
            areaId: location.areaId,
            roomId: location.roomId,
            spaceId: location.spaceId,
            accessWindowStart: row.accessWindowStart.toISOString(),
            accessWindowEnd: row.accessWindowEnd.toISOString(),
          },
        },
        tx,
      );
      return toPublic(row);
    });
  } catch (error) {
    if (isActiveUniqueViolation(error)) {
      throw handymanUnitAccessReadinessAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Material readiness change: supersede the ACTIVE row with a fresh
 * window/note. Atomic: old row → INACTIVE + SUPERSEDED event and new
 * ACTIVE row + CREATED event in ONE transaction. Location is re-derived
 * from the request/master authority — never accepted as input.
 */
export async function supersedeHandymanUnitAccessReadiness(
  readinessId: string,
  input: SupersedeHandymanUnitAccessReadinessInput,
  actorUserId: string,
): Promise<PublicHandymanUnitAccessReadiness> {
  ensureUuid(readinessId, 'readinessId');
  ensureUuid(actorUserId, 'actorUserId');
  const { start, end } = parseWindow(
    input.accessWindowStart,
    input.accessWindowEnd,
  );
  const authorizationNote = ensureNote(input.authorizationNote);

  try {
    return await withTransaction(async (tx) => {
      const current = await handymanUnitAccessReadinessRepository.lockById(
        tx,
        readinessId,
      );
      if (!current) throw handymanUnitAccessReadinessNotFoundError();
      if (!(await contextAccessService.canAccessClient(actorUserId, current.clientId))) {
        throw buildingAccessDeniedError();
      }
      if (current.status !== 'ACTIVE') {
        throw handymanUnitAccessReadinessInvalidStatusError();
      }

      const request = await handymanServiceRequestRepository.findById(
        tx,
        current.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();
      const location = await deriveHandymanLocationChain(request);

      const superseded = await handymanUnitAccessReadinessRepository
        .setStatus(tx, current.id, 'INACTIVE');
      if (!superseded) throw handymanUnitAccessReadinessNotFoundError();
      const row = await handymanUnitAccessReadinessRepository.insert(tx, {
        clientId: current.clientId,
        handymanRequestId: current.handymanRequestId,
        ...location,
        accessWindowStart: start,
        accessWindowEnd: end,
        authorizationNote,
        supersedesReadinessId: current.id,
        authorizedByUserId: actorUserId,
      });

      const journalBase = { clientId: current.clientId, actorUserId };
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_UNIT_ACCESS_READINESS_SUPERSEDED',
          entityType: 'HANDYMAN_UNIT_ACCESS_READINESS',
          entityId: superseded.id,
          summary: 'Handyman unit access readiness superseded.',
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
          eventType: 'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
          entityType: 'HANDYMAN_UNIT_ACCESS_READINESS',
          entityId: row.id,
          summary:
            'Handyman unit access readiness created (ACTIVE, supersession).',
          metadata: {
            readinessId: row.id,
            supersedesReadinessId: superseded.id,
            handymanRequestId: current.handymanRequestId,
            buildingId: location.buildingId,
            spaceId: location.spaceId,
            accessWindowStart: row.accessWindowStart.toISOString(),
            accessWindowEnd: row.accessWindowEnd.toISOString(),
          },
        },
        tx,
      );
      return toPublic(row);
    });
  } catch (error) {
    if (isActiveUniqueViolation(error)) {
      throw handymanUnitAccessReadinessAlreadyExistsError();
    }
    throw error;
  }
}

/** Bounded read: current ACTIVE fact + full preserved history. */
export async function getHandymanUnitAccessReadiness(
  handymanRequestId: string,
  actorUserId?: string,
): Promise<{
  current: PublicHandymanUnitAccessReadiness | null;
  history: PublicHandymanUnitAccessReadiness[];
}> {
  ensureUuid(handymanRequestId, 'handymanRequestId');
  if (actorUserId !== undefined) ensureUuid(actorUserId, 'actorUserId');
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (
    actorUserId !== undefined &&
    !(await contextAccessService.canAccessClient(actorUserId, request.clientId))
  ) {
    throw buildingAccessDeniedError();
  }
  const current = await handymanUnitAccessReadinessRepository
    .findActiveByRequest(undefined, request.id);
  const history = await handymanUnitAccessReadinessRepository.listByRequest(
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
 * authority; operational events stay audit history only). No arrival
 * semantics exist anywhere in this history (F6).
 */
export async function listHandymanUnitAccessReadinessHistory(
  handymanRequestId: string,
  actorUserId: string,
): Promise<PublicHandymanUnitAccessReadiness[]> {
  ensureUuid(handymanRequestId, 'handymanRequestId');
  ensureUuid(actorUserId, 'actorUserId');
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (!(await contextAccessService.canAccessClient(actorUserId, request.clientId))) {
    throw buildingAccessDeniedError();
  }
  const rows = await handymanUnitAccessReadinessRepository.listByRequest(
    undefined,
    request.id,
  );
  return rows.map(toPublic);
}

export const handymanUnitAccessReadinessService = {
  createHandymanUnitAccessReadiness,
  supersedeHandymanUnitAccessReadiness,
  getHandymanUnitAccessReadiness,
  listHandymanUnitAccessReadinessHistory,
};
