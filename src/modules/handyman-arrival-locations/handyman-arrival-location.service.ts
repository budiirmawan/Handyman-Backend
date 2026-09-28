import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { generateSessionToken, hashSessionToken } from '../auth/session.token';
import {
  handymanExecutionScopeNotFoundError,
  handymanExecutionScopeRepository,
} from '../handyman-quotations';
import {
  arrivalLocationIdentifierNotFoundError,
  arrivalLocationIdentifierValidationError,
} from './handyman-arrival-location.errors';
import { handymanArrivalLocationRepository }
  from './handyman-arrival-location.repository';
import type {
  CreateHandymanArrivalLocationIdentifierInput,
  HandymanArrivalLocationIdentifierCreateResult,
  HandymanArrivalLocationIdentifierRecord,
  HandymanArrivalQrSignal,
  HandymanExpectedArrivalLocation,
  HandymanLocationChain,
  PublicHandymanArrivalLocationIdentifier,
  ResolveHandymanArrivalQrSignalInput,
} from './handyman-arrival-location.types';

/**
 * CR-HM-07 Arrival Verification PART 02 — expected-location resolver,
 * opaque QR location-identifier registry, and bounded QR SIGNAL
 * comparison (FROZEN governance §C/§G).
 *
 * Authority: the expected location is the IMMUTABLE CR-HM-06
 * Execution Scope snapshot — caller/QR/crew/GPS can never replace it.
 * QR is an opaque presence/location identifier ONLY: the server
 * resolves a raw scan to an authoritative location chain and returns
 * MATCH / MISMATCH / UNKNOWN / INACTIVE — NEVER an arrival
 * VERIFIED/FAILED verdict, and QR alone proves nothing. PART 02 NEVER
 * consumes the PART 01 challenge (challenges remain a separate
 * authority; a later PART composes challenge + QR + risk signals).
 * NO geofence/GPS, NO work-session/check-in, NO attendance, NO
 * scheduling mutation, NO payment/BAST, NO FM patrol/checkpoint/
 * work_order semantics. NO HTTP/OpenAPI (a later PART).
 */

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw new Error(`HANDYMAN_ARRIVAL_LOCATION_INVALID_UUID:${field}`);
  }
  return raw;
}

function optionalUuid(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  return ensureUuid(value, field);
}

function toPublic(
  record: HandymanArrivalLocationIdentifierRecord,
): PublicHandymanArrivalLocationIdentifier {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    spaceId: record.spaceId,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function chainOf(
  record: HandymanArrivalLocationIdentifierRecord,
): HandymanLocationChain {
  return {
    buildingId: record.buildingId,
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    spaceId: record.spaceId,
  };
}

/**
 * Deepest non-null snapshot level (space > room > area > floor >
 * building). When the snapshot carries no deeper link, the rule
 * NEVER invents a stricter child requirement.
 */

/**
 * Pure selector of the deepest non-null snapshot level (space >
 * room > area > floor > building). Exported so PART 03+ and focused
 * tests can target the exact hierarchy rule without synthesis.
 */
export function selectMostSpecificExpectedLocationLevel(
  expected: HandymanExpectedArrivalLocation,
): 'spaceId' | 'roomId' | 'areaId' | 'floorId' | 'buildingId' {
  if (expected.spaceId) return 'spaceId';
  if (expected.roomId) return 'roomId';
  if (expected.areaId) return 'areaId';
  if (expected.floorId) return 'floorId';
  return 'buildingId';
}

/**
 * Authoritative expected-arrival location: the immutable CR-HM-06
 * execution-scope snapshot ONLY. Realm-guarded (Client access), and
 * the result contains exactly the snapshot chain — nothing else.
 */
export async function resolveHandymanExpectedArrivalLocation(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanExpectedArrivalLocation> {
  ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId, scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }
  return {
    buildingId: scope.buildingId,
    floorId: scope.floorId,
    areaId: scope.areaId,
    roomId: scope.roomId,
    spaceId: scope.spaceId,
  };
}

/**
 * Register an opaque Handyman location identifier (QR). The server
 * GENERATES the opaque value (existing secure-random convention),
 * returns it exactly once, and persists only the SHA-256 hash. The
 * chain is validated against the EXISTING location masters and the
 * Client is derived from the building — caller can never author
 * clientId/status/hash, and meaningful location ids never appear in
 * the raw payload.
 */
export async function createHandymanArrivalLocationIdentifier(
  input: CreateHandymanArrivalLocationIdentifierInput,
  actorUserId: string,
): Promise<HandymanArrivalLocationIdentifierCreateResult> {
  const buildingId = ensureUuid(input.buildingId, 'buildingId');
  const floorId = optionalUuid(input.floorId, 'floorId');
  const areaId = optionalUuid(input.areaId, 'areaId');
  const roomId = optionalUuid(input.roomId, 'roomId');
  const spaceId = optionalUuid(input.spaceId, 'spaceId');
  ensureUuid(actorUserId, 'actorUserId');

  const building = await handymanArrivalLocationRepository
    .findBuildingAuthority(undefined, buildingId);
  if (!building || building.status !== 'ACTIVE') {
    throw arrivalLocationIdentifierValidationError([
      { field: 'buildingId', message: 'Building must exist and be ACTIVE.' },
    ]);
  }
  if (!(await contextAccessService.canAccessClient(
    actorUserId, building.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }

  // Chain: completeness + real parent linkage against location masters.
  const details: { field: string; message: string }[] = [];
  if (!floorId && (areaId || roomId || spaceId)) {
    details.push({
      field: 'floorId',
      message: 'Deeper links require the floor link.',
    });
  }
  if (areaId && !floorId) {
    details.push({ field: 'areaId', message: 'An area requires a floor.' });
  }
  if (roomId && !areaId) {
    details.push({ field: 'roomId', message: 'A room requires an area.' });
  }
  if (spaceId && !roomId) {
    details.push({ field: 'spaceId', message: 'A space requires a room.' });
  }
  if (floorId) {
    const f = await handymanArrivalLocationRepository.masterParent(
      undefined, 'floors', 'building_id', floorId,
    );
    if (!f || f.parentId !== buildingId || f.status !== 'ACTIVE') {
      details.push({
        field: 'floorId',
        message: 'Floor must exist, be ACTIVE, and belong to the building.',
      });
    }
  }
  if (areaId) {
    const a = await handymanArrivalLocationRepository.masterParent(
      undefined, 'areas', 'floor_id', areaId,
    );
    if (!a || a.parentId !== floorId || a.status !== 'ACTIVE') {
      details.push({
        field: 'areaId',
        message: 'Area must exist, be ACTIVE, and belong to the floor.',
      });
    }
  }
  if (roomId) {
    const r = await handymanArrivalLocationRepository.masterParent(
      undefined, 'rooms', 'area_id', roomId,
    );
    if (!r || r.parentId !== areaId || r.status !== 'ACTIVE') {
      details.push({
        field: 'roomId',
        message: 'Room must exist, be ACTIVE, and belong to the area.',
      });
    }
  }
  if (spaceId) {
    const sp = await handymanArrivalLocationRepository.masterParent(
      undefined, 'spaces', 'room_id', spaceId,
    );
    if (!sp || sp.parentId !== roomId || sp.status !== 'ACTIVE') {
      details.push({
        field: 'spaceId',
        message: 'Space must exist, be ACTIVE, and belong to the room.',
      });
    }
  }
  if (details.length > 0) {
    throw arrivalLocationIdentifierValidationError(details);
  }

  const value = generateSessionToken(32);
  const opaqueCodeHash = hashSessionToken(value);

  return withTransaction(async (tx) => {
    const record = await handymanArrivalLocationRepository
      .insertIdentifier(tx, {
        clientId: building.clientId,
        opaqueCodeHash,
        buildingId,
        floorId,
        areaId,
        roomId,
        spaceId,
      });
    await recordOperationalEvent(
      {
        clientId: record.clientId,
        eventType: 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_CREATED',
        entityType: 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER',
        entityId: record.id,
        actorUserId,
        summary:
          'Handyman arrival location identifier registered (opaque value issued once).',
        metadata: {
          identifierId: record.id,
          buildingId: record.buildingId,
          // raw value / hash material is NEVER journaled.
        },
      },
      tx,
    );
    return { identifier: toPublic(record), value };
  });
}

/**
 * Registry lifecycle management: ACTIVE -> INACTIVE (the only
 * permitted write), audited. Realm-guarded.
 */
export async function deactivateHandymanArrivalLocationIdentifier(
  identifierId: string,
  actorUserId: string,
): Promise<PublicHandymanArrivalLocationIdentifier> {
  ensureUuid(identifierId, 'identifierId');
  ensureUuid(actorUserId, 'actorUserId');
  const existing = await handymanArrivalLocationRepository
    .findIdentifierById(undefined, identifierId);
  if (!existing) throw arrivalLocationIdentifierNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId, existing.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }
  return withTransaction(async (tx) => {
    const record = await handymanArrivalLocationRepository
      .deactivateIdentifier(tx, identifierId);
    if (!record) throw arrivalLocationIdentifierNotFoundError();
    await recordOperationalEvent(
      {
        clientId: record.clientId,
        eventType: 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_DEACTIVATED',
        entityType: 'HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER',
        entityId: record.id,
        actorUserId,
        summary: 'Handyman arrival location identifier deactivated.',
        metadata: { identifierId: record.id, buildingId: record.buildingId },
      },
      tx,
    );
    return toPublic(record);
  });
}

/**
 * QR scan → bounded SIGNAL comparison. Resolution NEVER trusts the
 * raw value; it hashes it and compares the resolved identifier's
 * authoritative chain against the immutable expected snapshot at its
 * most-specific level. Cross-Client codes and unknown hashes share
 * the exact UNKNOWN shape (non-enumerating firewall). No event is
 * generated: a signal is not an arrival fact.
 */
export async function resolveHandymanArrivalQrSignal(
  input: ResolveHandymanArrivalQrSignalInput,
  actorUserId: string,
): Promise<HandymanArrivalQrSignal> {
  const expected = await resolveHandymanExpectedArrivalLocation(
    input.executionScopeId,
    actorUserId,
  );
  const raw = typeof input.rawValue === 'string' ? input.rawValue : '';
  if (raw.length === 0) {
    return { signal: 'UNKNOWN', identifierId: null, location: null };
  }
  const identifier = await handymanArrivalLocationRepository
    .findByOpaqueCodeHash(undefined, hashSessionToken(raw));
  if (!identifier) {
    return { signal: 'UNKNOWN', identifierId: null, location: null };
  }
  // Client firewall: a foreign Client's code is indistinguishable
  // from unknown material (fail closed, non-enumerating).
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    input.executionScopeId,
  );
  if (!scope || identifier.clientId !== scope.clientId) {
    return { signal: 'UNKNOWN', identifierId: null, location: null };
  }
  if (identifier.status !== 'ACTIVE') {
    return {
      signal: 'INACTIVE',
      identifierId: identifier.id,
      location: chainOf(identifier),
    };
  }
  // Match rule: identifier must equal the expected snapshot exactly
  // at the snapshot's most-specific non-null level. Identifier chains
  // DEEPER than that level may still correspond (their parent link at
  // the comparison level is what is compared); identifier chains
  // SHALLOWER than it cannot attest the expected location.
  const level = selectMostSpecificExpectedLocationLevel(expected);
  const match = identifier[level] === expected[level];
  return {
    signal: match ? 'MATCH' : 'MISMATCH',
    identifierId: identifier.id,
    location: chainOf(identifier),
  };
}

export const handymanArrivalLocationService = {
  resolveHandymanExpectedArrivalLocation,
  selectMostSpecificExpectedLocationLevel,
  createHandymanArrivalLocationIdentifier,
  deactivateHandymanArrivalLocationIdentifier,
  resolveHandymanArrivalQrSignal,
};
