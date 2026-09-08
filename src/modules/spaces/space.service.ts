import { resolveAreaBuildingId, roomNotFoundError, roomRepository } from '../rooms';
import {
  spaceCodeAlreadyExistsError,
  spaceNotFoundError,
  spaceRoomInactiveError,
} from './space.errors';
import { spaceRepository } from './space.repository';
import type {
  CreateSpaceInput,
  NewSpace,
  PublicSpace,
  SpaceRecord,
  UpdateSpaceInput,
  UpdateSpaceStatusInput,
} from './space.types';

export function toPublicSpace(record: SpaceRecord): PublicSpace {
  return {
    id: record.id,
    roomId: record.roomId,
    code: record.code,
    name: record.name,
    description: record.description,
    areaSqm: record.areaSqm === null ? null : Number(record.areaSqm),
    status: record.status,
  };
}

/**
 * Resolves the Building that hosts a Room (unknown Room → 404). This is the
 * single place Space routes walk Room → Area → Floor → Building, so Space
 * isolation can never drift from Building isolation.
 */
export async function resolveRoomBuildingId(roomId: string): Promise<string> {
  const room = await roomRepository.findById(roomId);
  if (!room) {
    throw roomNotFoundError();
  }
  return resolveAreaBuildingId(room.areaId);
}

/**
 * Creates a Space under a Room.
 *
 * Validation order (pinned by tests):
 *   1. unknown Room              → 404 ROOM_NOT_FOUND
 *   2. INACTIVE Room             → 400 ROOM_NOT_AVAILABLE
 *   3. duplicate code for Room   → 409 SPACE_CODE_ALREADY_EXISTS
 *
 * The `(room_id, code)` unique constraint remains the final authority — it
 * also covers the race between the pre-check and the INSERT. Client/Building
 * context is preserved implicitly: a Space carries only `room_id`, so
 * ownership is always derived Space → Room → Area → Floor → Building →
 * Property → Client.
 */
export async function createSpace(input: CreateSpaceInput): Promise<PublicSpace> {
  const room = await roomRepository.findById(input.roomId);
  if (!room) {
    throw roomNotFoundError();
  }
  if (room.status !== 'ACTIVE') {
    throw spaceRoomInactiveError();
  }

  const existing = await spaceRepository.findByCodeForRoom(
    input.roomId,
    input.code,
  );
  if (existing) {
    throw spaceCodeAlreadyExistsError();
  }

  const newSpace: NewSpace = {
    roomId: input.roomId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    areaSqm: input.areaSqm ?? null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await spaceRepository.createSpace(newSpace);
    return toPublicSpace(record);
  } catch (error) {
    if (isSpaceCodeUniqueViolation(error)) {
      throw spaceCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getSpaceById(id: string): Promise<PublicSpace> {
  const record = await spaceRepository.findById(id);
  if (!record) {
    throw spaceNotFoundError();
  }
  return toPublicSpace(record);
}

/**
 * Lists the Spaces of one Room.
 *
 * The Room is validated first (unknown Room → 404 rather than an empty list)
 * and the query is scoped to `room_id`, so another Room's spaces are never
 * reachable through this route.
 */
export async function listSpacesByRoom(roomId: string): Promise<PublicSpace[]> {
  const room = await roomRepository.findById(roomId);
  if (!room) {
    throw roomNotFoundError();
  }

  const records = await spaceRepository.listByRoom(roomId);
  return records.map(toPublicSpace);
}

/**
 * Partially updates a Space (name, description, status).
 *
 * `roomId` and `code` are deliberately immutable — a Space never migrates
 * between Rooms, and its code is the stable identifier operational context
 * (BE-04G+) will reference.
 */
export async function updateSpace(
  id: string,
  input: UpdateSpaceInput,
): Promise<PublicSpace> {
  const existing = await spaceRepository.findById(id);
  if (!existing) {
    throw spaceNotFoundError();
  }

  const record = await spaceRepository.updateSpace(id, input);
  return toPublicSpace(record as SpaceRecord);
}

/**
 * Activates or deactivates a Space. Deactivating is not a delete: the Space
 * remains persisted for history; it simply stops being an active subdivision.
 */
export async function updateSpaceStatus(
  id: string,
  input: UpdateSpaceStatusInput,
): Promise<PublicSpace> {
  const existing = await spaceRepository.findById(id);
  if (!existing) {
    throw spaceNotFoundError();
  }

  const record = await spaceRepository.updateStatus(id, input.status);
  return toPublicSpace(record as SpaceRecord);
}

function isSpaceCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'spaces_room_code_unique'
  );
}

export const spaceService = {
  createSpace,
  getSpaceById,
  listSpacesByRoom,
  resolveRoomBuildingId,
  toPublicSpace,
  updateSpace,
  updateSpaceStatus,
};
