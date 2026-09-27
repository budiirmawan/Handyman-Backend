import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanServiceRequestNotFoundError,
  handymanServiceRequestRepository,
} from '../handyman-requests';
import { handymanPermitReadinessRepository } from './handyman-permit-readiness.repository';
import { handymanUnitAccessReadinessRepository } from './handyman-unit-access.repository';
import { deriveHandymanLocationChain } from './handyman-unit-access.service';
import { handymanUnitAccessReadinessLocationInconsistentError } from './handyman-unit-access.errors';
import {
  handymanPermitReadinessAlreadyExistsError,
  handymanPermitReadinessInvalidStatusError,
  handymanPermitReadinessNotFoundError,
  handymanPermitReadinessTypeUnsupportedError,
  handymanPermitReadinessValidityInvalidError,
} from './handyman-permit-readiness.errors';
import {
  isHandymanPermitType,
} from './handyman-permit-readiness.types';
import type {
  CreateHandymanPermitReadinessInput,
  HandymanPermitReadinessRecord,
  HandymanPermitType,
  PublicHandymanPermitReadiness,
  SupersedeHandymanPermitReadinessInput,
} from './handyman-permit-readiness.types';

/**
 * CR-HM-05 PART 03 — Handyman Permit Readiness service (FROZEN
 * containment F4/F5/F7/F8/F9/F10).
 *
 * AUTHORIZATION/READINESS ONLY for tenant/unit service access. It is
 * NOT FM Permit-to-Work, NOT execution authorization: validity proves
 * no arrival, no on-site identity verification, no work start, no
 * completed safety inspection. The FM permit engine is reused ONLY as
 * pattern/infrastructure knowledge — this service never inserts/updates
 * FM `permits`, never references FM work orders, never adopts the FM
 * PTW state machine or its approval chain, never binds provider/crew
 * and never creates an execution target. Location is SERVER-DERIVED
 * from the authoritative request/master chain and must agree with any
 * ACTIVE Unit Access Readiness (F5). Material changes supersede rows
 * atomically with append-only journal events (F8).
 */

function ensureUuid(value: string, field: string): void {
  const ok =
    typeof value === 'string' &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
      .test(value.trim());
  if (!ok) {
    throw handymanPermitReadinessNotFoundError();
  }
}

function parseValidity(
  fromRaw: string,
  untilRaw: string,
): { from: Date; until: Date } {
  if (typeof fromRaw !== 'string' || typeof untilRaw !== 'string') {
    throw handymanPermitReadinessValidityInvalidError();
  }
  const from = new Date(fromRaw.trim());
  const until = new Date(untilRaw.trim());
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(until.getTime()) ||
    from.getTime() >= until.getTime()
  ) {
    throw handymanPermitReadinessValidityInvalidError();
  }
  return { from, until };
}

function ensureType(value: string): HandymanPermitType {
  if (!isHandymanPermitType(value)) {
    throw handymanPermitReadinessTypeUnsupportedError();
  }
  return value;
}

function ensureNote(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 1 || trimmed.length > 1000) {
    throw handymanPermitReadinessValidityInvalidError();
  }
  return trimmed;
}

function toPublic(
  record: HandymanPermitReadinessRecord,
): PublicHandymanPermitReadiness {
  return {
    ...record,
    validFrom: record.validFrom.toISOString(),
    validUntil: record.validUntil.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isActiveUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return (
    e?.code === '23505' &&
    e?.constraint === 'handyman_permit_readiness_active_unique'
  );
}

/**
 * Location must agree with the ACTIVE Unit Access Readiness when one
 * exists (both derive from the same authority; a disagreement is an
 * integrity fault, never silently accepted).
 */
async function assertAccessReadinessAgreement(
  executor: Parameters<typeof handymanUnitAccessReadinessRepository.findActiveByRequest>[0],
  handymanRequestId: string,
  location: { buildingId: string; spaceId: string },
): Promise<void> {
  const activeAccess = await handymanUnitAccessReadinessRepository
    .findActiveByRequest(executor, handymanRequestId);
  if (!activeAccess) return;
  if (
    activeAccess.buildingId !== location.buildingId ||
    activeAccess.spaceId !== location.spaceId
  ) {
    throw handymanUnitAccessReadinessLocationInconsistentError();
  }
}

/**
 * Create the ACTIVE permit-readiness fact for a request (one per
 * request). Atomic: row + CREATED journal event in ONE transaction; a
 * concurrent create loses the partial-UNIQUE race and surfaces as 409.
 */
export async function createHandymanPermitReadiness(
  input: CreateHandymanPermitReadinessInput,
  actorUserId: string,
): Promise<PublicHandymanPermitReadiness> {
  ensureUuid(input.handymanRequestId, 'handymanRequestId');
  ensureUuid(actorUserId, 'actorUserId');
  const permitType = ensureType(input.permitType);
  const { from, until } = parseValidity(input.validFrom, input.validUntil);
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
      await assertAccessReadinessAgreement(tx, request.id, location);
      const existing = await handymanPermitReadinessRepository
        .findActiveByRequest(tx, request.id);
      if (existing) throw handymanPermitReadinessAlreadyExistsError();

      const row = await handymanPermitReadinessRepository.insert(tx, {
        clientId: request.clientId,
        handymanRequestId: request.id,
        ...location,
        permitType,
        validFrom: from,
        validUntil: until,
        authorizationNote,
        authorizedByUserId: actorUserId,
      });
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_PERMIT_READINESS_CREATED',
          entityType: 'HANDYMAN_PERMIT_READINESS',
          entityId: row.id,
          summary: 'Handyman permit readiness created (ACTIVE).',
          metadata: {
            readinessId: row.id,
            handymanRequestId: request.id,
            buildingId: location.buildingId,
            spaceId: location.spaceId,
            permitType: row.permitType,
            validFrom: row.validFrom.toISOString(),
            validUntil: row.validUntil.toISOString(),
          },
        },
        tx,
      );
      return toPublic(row);
    });
  } catch (error) {
    if (isActiveUniqueViolation(error)) {
      throw handymanPermitReadinessAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Material permit change: supersede the ACTIVE row with fresh
 * type/validity/note. Atomic: old row → INACTIVE + SUPERSEDED event and
 * new ACTIVE row + CREATED event in ONE transaction. Location is
 * re-derived from the request/master authority — never accepted.
 */
export async function supersedeHandymanPermitReadiness(
  readinessId: string,
  input: SupersedeHandymanPermitReadinessInput,
  actorUserId: string,
): Promise<PublicHandymanPermitReadiness> {
  ensureUuid(readinessId, 'readinessId');
  ensureUuid(actorUserId, 'actorUserId');
  const permitType = ensureType(input.permitType);
  const { from, until } = parseValidity(input.validFrom, input.validUntil);
  const authorizationNote = ensureNote(input.authorizationNote);

  try {
    return await withTransaction(async (tx) => {
      const current = await handymanPermitReadinessRepository.lockById(
        tx,
        readinessId,
      );
      if (!current) throw handymanPermitReadinessNotFoundError();
      if (!(await contextAccessService.canAccessClient(actorUserId, current.clientId))) {
        throw buildingAccessDeniedError();
      }
      if (current.status !== 'ACTIVE') {
        throw handymanPermitReadinessInvalidStatusError();
      }

      const request = await handymanServiceRequestRepository.findById(
        tx,
        current.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();
      const location = await deriveHandymanLocationChain(request);
      await assertAccessReadinessAgreement(tx, request.id, location);

      const superseded = await handymanPermitReadinessRepository
        .setStatus(tx, current.id, 'INACTIVE');
      if (!superseded) throw handymanPermitReadinessNotFoundError();
      const row = await handymanPermitReadinessRepository.insert(tx, {
        clientId: current.clientId,
        handymanRequestId: current.handymanRequestId,
        ...location,
        permitType,
        validFrom: from,
        validUntil: until,
        authorizationNote,
        authorizedByUserId: actorUserId,
      });

      const journalBase = { clientId: current.clientId, actorUserId };
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_PERMIT_READINESS_SUPERSEDED',
          entityType: 'HANDYMAN_PERMIT_READINESS',
          entityId: superseded.id,
          summary: 'Handyman permit readiness superseded.',
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
          eventType: 'HANDYMAN_PERMIT_READINESS_CREATED',
          entityType: 'HANDYMAN_PERMIT_READINESS',
          entityId: row.id,
          summary:
            'Handyman permit readiness created (ACTIVE, supersession).',
          metadata: {
            readinessId: row.id,
            supersedesReadinessId: superseded.id,
            handymanRequestId: current.handymanRequestId,
            buildingId: location.buildingId,
            spaceId: location.spaceId,
            permitType: row.permitType,
            validFrom: row.validFrom.toISOString(),
            validUntil: row.validUntil.toISOString(),
          },
        },
        tx,
      );
      return toPublic(row);
    });
  } catch (error) {
    if (isActiveUniqueViolation(error)) {
      throw handymanPermitReadinessAlreadyExistsError();
    }
    throw error;
  }
}

/** Bounded read: current ACTIVE fact + full preserved history. */
export async function getHandymanPermitReadiness(
  handymanRequestId: string,
  actorUserId?: string,
): Promise<{
  current: PublicHandymanPermitReadiness | null;
  history: PublicHandymanPermitReadiness[];
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
  const current = await handymanPermitReadinessRepository
    .findActiveByRequest(undefined, request.id);
  const history = await handymanPermitReadinessRepository.listByRequest(
    undefined,
    request.id,
  );
  return {
    current: current ? toPublic(current) : null,
    history: history.map(toPublic),
  };
}

export const handymanPermitReadinessService = {
  createHandymanPermitReadiness,
  supersedeHandymanPermitReadiness,
  getHandymanPermitReadiness,
};
