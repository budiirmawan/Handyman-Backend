import { areaNotFoundError, areaRepository } from '../areas';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { floorNotFoundError, floorRepository } from '../floors';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { propertyNotFoundError, propertyRepository } from '../properties';
import { roomNotFoundError, roomRepository } from '../rooms';
import { securityPostNotFoundError, securityPostRepository } from '../security-posts';
import { spaceNotFoundError, spaceRepository } from '../spaces';
import {
  patrolRouteBuildingInactiveError,
  patrolRouteCodeAlreadyExistsError,
  patrolRouteNotFoundError,
  patrolRoutePointDuplicateSequenceError,
  patrolRoutePointLocationMismatchError,
  patrolRoutePointNotFoundError,
  patrolRoutePointRouteMismatchError,
  patrolRoutePointSequenceInvalidError,
  patrolRouteStartPostInactiveError,
  patrolRouteStartPostMismatchError,
} from './patrol-route.errors';
import { patrolRoutePointRepository } from './patrol-route-point.repository';
import { patrolRouteRepository } from './patrol-route.repository';
import type {
  CreatePatrolRouteInput,
  CreatePatrolRoutePointInput,
  PatrolRoutePointRecord,
  PatrolRouteRecord,
  PatrolRouteStatus,
  PublicPatrolRoute,
  PublicPatrolRoutePoint,
  UpdatePatrolRouteInput,
  UpdatePatrolRoutePointInput,
} from './patrol-route.types';

/* ------------------------------------------------------------------ */
/*  Public mappers                                                     */
/* ------------------------------------------------------------------ */

export function toPublicPatrolRoute(
  record: PatrolRouteRecord,
): PublicPatrolRoute {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    startSecurityPostId: record.startSecurityPostId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicPatrolRoutePoint(
  record: PatrolRoutePointRecord,
): PublicPatrolRoutePoint {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    patrolRouteId: record.patrolRouteId,
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    spaceId: record.spaceId,
    functionalLocationId: record.functionalLocationId,
    sequence: record.sequence,
    notes: record.notes,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Location validation (reused from BE-12A pattern)                   */
/* ------------------------------------------------------------------ */

async function assertLocationReferences(
  buildingId: string,
  locations: {
    floorId?: string | null;
    areaId?: string | null;
    roomId?: string | null;
    spaceId?: string | null;
    functionalLocationId?: string | null;
  },
): Promise<void> {
  if (locations.floorId) {
    const floor = await floorRepository.findById(locations.floorId);
    if (!floor) {
      throw floorNotFoundError();
    }
    if (floor.buildingId !== buildingId) {
      throw patrolRoutePointLocationMismatchError(
        'The referenced floor does not belong to this building.',
      );
    }
  }

  if (locations.areaId) {
    const area = await areaRepository.findById(locations.areaId);
    if (!area) {
      throw areaNotFoundError();
    }
    const floor = await floorRepository.findById(area.floorId);
    if (!floor || floor.buildingId !== buildingId) {
      throw patrolRoutePointLocationMismatchError(
        'The referenced area does not belong to this building.',
      );
    }
    if (locations.floorId && area.floorId !== locations.floorId) {
      throw patrolRoutePointLocationMismatchError(
        'The referenced area does not belong to the referenced floor.',
      );
    }
  }

  if (locations.roomId) {
    const room = await roomRepository.findById(locations.roomId);
    if (!room) {
      throw roomNotFoundError();
    }
    const area = await areaRepository.findById(room.areaId);
    const floor = area ? await floorRepository.findById(area.floorId) : null;
    if (!floor || floor.buildingId !== buildingId) {
      throw patrolRoutePointLocationMismatchError(
        'The referenced room does not belong to this building.',
      );
    }
    if (locations.areaId && room.areaId !== locations.areaId) {
      throw patrolRoutePointLocationMismatchError(
        'The referenced room does not belong to the referenced area.',
      );
    }
  }

  if (locations.spaceId) {
    const space = await spaceRepository.findById(locations.spaceId);
    if (!space) {
      throw spaceNotFoundError();
    }
    const room = await roomRepository.findById(space.roomId);
    const area = room ? await areaRepository.findById(room.areaId) : null;
    const floor = area ? await floorRepository.findById(area.floorId) : null;
    if (!floor || floor.buildingId !== buildingId) {
      throw patrolRoutePointLocationMismatchError(
        'The referenced space does not belong to this building.',
      );
    }
    if (locations.roomId && space.roomId !== locations.roomId) {
      throw patrolRoutePointLocationMismatchError(
        'The referenced space does not belong to the referenced room.',
      );
    }
  }

  if (locations.functionalLocationId) {
    const fl = await functionalLocationRepository.findById(
      locations.functionalLocationId,
    );
    if (!fl) {
      throw functionalLocationNotFoundError();
    }
    if (fl.buildingId !== buildingId) {
      throw patrolRoutePointLocationMismatchError(
        'The referenced functional location does not belong to this building.',
      );
    }
  }
}

/**
 * Asserts the start Security Post (when provided) exists, is ACTIVE, and
 * belongs to the same Building.
 */
async function assertStartSecurityPost(
  startSecurityPostId: string,
  buildingId: string,
): Promise<void> {
  const post = await securityPostRepository.findById(startSecurityPostId);
  if (!post) {
    throw securityPostNotFoundError();
  }
  if (post.buildingId !== buildingId) {
    throw patrolRouteStartPostMismatchError();
  }
  if (post.status !== 'ACTIVE') {
    throw patrolRouteStartPostInactiveError();
  }
}

/* ------------------------------------------------------------------ */
/*  Patrol Route operations                                            */
/* ------------------------------------------------------------------ */

export async function createPatrolRoute(
  input: CreatePatrolRouteInput,
): Promise<PublicPatrolRoute> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  if (building.status !== 'ACTIVE') {
    throw patrolRouteBuildingInactiveError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  const clientId = property.clientId;

  if (input.startSecurityPostId) {
    await assertStartSecurityPost(input.startSecurityPostId, input.buildingId);
  }

  const existing = await patrolRouteRepository.findByCodeForBuilding(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw patrolRouteCodeAlreadyExistsError();
  }

  try {
    const record = await patrolRouteRepository.create({
      ...input,
      clientId,
    });
    return toPublicPatrolRoute(record);
  } catch (error) {
    if (isPatrolRouteCodeUniqueViolation(error)) {
      throw patrolRouteCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getPatrolRouteById(
  id: string,
): Promise<PublicPatrolRoute> {
  const record = await patrolRouteRepository.findById(id);
  if (!record) {
    throw patrolRouteNotFoundError();
  }
  return toPublicPatrolRoute(record);
}

export async function listPatrolRoutesByBuilding(
  buildingId: string,
): Promise<PublicPatrolRoute[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const records = await patrolRouteRepository.listByBuilding(buildingId);
  return records.map(toPublicPatrolRoute);
}

export async function updatePatrolRoute(
  id: string,
  input: UpdatePatrolRouteInput,
): Promise<PublicPatrolRoute> {
  const existing = await patrolRouteRepository.findById(id);
  if (!existing) {
    throw patrolRouteNotFoundError();
  }

  if (input.startSecurityPostId !== undefined) {
    if (input.startSecurityPostId === null) {
      // Clear the start post — allowed unconditionally.
    } else {
      await assertStartSecurityPost(
        input.startSecurityPostId,
        existing.buildingId,
      );
    }
  }

  const record = await patrolRouteRepository.update(id, input);
  return toPublicPatrolRoute(record as PatrolRouteRecord);
}

export async function updatePatrolRouteStatus(
  id: string,
  status: PatrolRouteStatus,
): Promise<PublicPatrolRoute> {
  const existing = await patrolRouteRepository.findById(id);
  if (!existing) {
    throw patrolRouteNotFoundError();
  }

  const record = await patrolRouteRepository.updateStatus(id, status);
  return toPublicPatrolRoute(record as PatrolRouteRecord);
}

/* ------------------------------------------------------------------ */
/*  Patrol Route Point operations                                      */
/* ------------------------------------------------------------------ */

export async function addPatrolRoutePoint(
  input: CreatePatrolRoutePointInput,
): Promise<PublicPatrolRoutePoint> {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw patrolRoutePointSequenceInvalidError();
  }

  const route = await patrolRouteRepository.findById(input.patrolRouteId);
  if (!route) {
    throw patrolRouteNotFoundError();
  }

  await assertLocationReferences(route.buildingId, input);

  // Defense in depth: also reject duplicate (route, sequence) explicitly
  // before the unique index fires so we always return a clean 409.
  const existing = await patrolRoutePointRepository.findByRouteAndSequence(
    input.patrolRouteId,
    input.sequence,
  );
  if (existing) {
    throw patrolRoutePointDuplicateSequenceError();
  }

  try {
    const record = await patrolRoutePointRepository.create({
      ...input,
      clientId: route.clientId,
      buildingId: route.buildingId,
    });
    return toPublicPatrolRoutePoint(record);
  } catch (error) {
    if (isPatrolRoutePointSequenceUniqueViolation(error)) {
      throw patrolRoutePointDuplicateSequenceError();
    }
    throw error;
  }
}

export async function listPatrolRoutePoints(
  patrolRouteId: string,
): Promise<PublicPatrolRoutePoint[]> {
  const route = await patrolRouteRepository.findById(patrolRouteId);
  if (!route) {
    throw patrolRouteNotFoundError();
  }

  const records = await patrolRoutePointRepository.listByRoute(patrolRouteId);
  return records.map(toPublicPatrolRoutePoint);
}

export async function updatePatrolRoutePoint(
  id: string,
  input: UpdatePatrolRoutePointInput,
  actorUserId: string,
): Promise<PublicPatrolRoutePoint> {
  if (input.sequence !== undefined) {
    if (!Number.isInteger(input.sequence) || input.sequence < 1) {
      throw patrolRoutePointSequenceInvalidError();
    }
  }

  const existing = await patrolRoutePointRepository.findById(id);
  if (!existing) {
    throw patrolRoutePointNotFoundError();
  }

  const route = await patrolRouteRepository.findById(existing.patrolRouteId);
  if (!route) {
    throw patrolRouteNotFoundError();
  }

  // DEF-J08-F-01 — Building authority is asserted against the checkpoint's
  // authoritative Building (point → route) BEFORE any mutation; a denied
  // request leaves the route point byte-equivalent.
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );

  if (
    input.floorId !== undefined ||
    input.areaId !== undefined ||
    input.roomId !== undefined ||
    input.spaceId !== undefined ||
    input.functionalLocationId !== undefined
  ) {
    await assertLocationReferences(route.buildingId, {
      floorId:
        input.floorId === undefined ? existing.floorId : input.floorId,
      areaId: input.areaId === undefined ? existing.areaId : input.areaId,
      roomId: input.roomId === undefined ? existing.roomId : input.roomId,
      spaceId: input.spaceId === undefined ? existing.spaceId : input.spaceId,
      functionalLocationId:
        input.functionalLocationId === undefined
          ? existing.functionalLocationId
          : input.functionalLocationId,
    });
  }

  if (input.sequence !== undefined && input.sequence !== existing.sequence) {
    const conflict = await patrolRoutePointRepository.findByRouteAndSequence(
      existing.patrolRouteId,
      input.sequence,
    );
    if (conflict) {
      throw patrolRoutePointDuplicateSequenceError();
    }
  }

  const updated = await patrolRoutePointRepository.update(id, input);

  // Defensive: ensure the updated point still belongs to the route it
  // claimed to belong to. (PATCH cannot change patrolRouteId, so this is
  // a guard against manual DB edits; in normal API flow it always holds.)
  if (
    updated &&
    updated.patrolRouteId !== existing.patrolRouteId
  ) {
    throw patrolRoutePointRouteMismatchError();
  }

  return toPublicPatrolRoutePoint(updated as PatrolRoutePointRecord);
}

/* ------------------------------------------------------------------ */
/*  Unique-violation classification                                    */
/* ------------------------------------------------------------------ */

function isPatrolRouteCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'patrol_routes_building_code_unique'
  );
}

function isPatrolRoutePointSequenceUniqueViolation(
  error: unknown,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'patrol_route_points_route_sequence_unique'
  );
}

export const patrolRouteService = {
  addPatrolRoutePoint,
  createPatrolRoute,
  getPatrolRouteById,
  listPatrolRoutePoints,
  listPatrolRoutesByBuilding,
  toPublicPatrolRoute,
  toPublicPatrolRoutePoint,
  updatePatrolRoute,
  updatePatrolRoutePoint,
  updatePatrolRouteStatus,
};
