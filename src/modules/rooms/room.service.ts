import { areaNotFoundError, areaRepository, resolveFloorBuildingId } from '../areas';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  roomTypeClientMismatchError,
  roomTypeInactiveError,
  roomTypeNotFoundError,
  roomTypeRepository,
} from '../room-types';
import {
  roomAreaInactiveError,
  roomCodeAlreadyExistsError,
  roomNotFoundError,
} from './room.errors';
import { roomRepository } from './room.repository';
import type {
  CreateRoomInput,
  NewRoom,
  PublicRoom,
  RoomRecord,
  UpdateRoomInput,
  UpdateRoomStatusInput,
} from './room.types';

export function toPublicRoom(record: RoomRecord): PublicRoom {
  return {
    id: record.id,
    areaId: record.areaId,
    roomTypeId: record.roomTypeId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

/**
 * Resolves the Building that hosts an Area (unknown Area → 404). This is the
 * single place Room routes walk Area → Floor → Building, so Room isolation
 * can never drift from Building isolation.
 */
export async function resolveAreaBuildingId(areaId: string): Promise<string> {
  const area = await areaRepository.findById(areaId);
  if (!area) {
    throw areaNotFoundError();
  }
  return resolveFloorBuildingId(area.floorId);
}

/**
 * Creates a Room under an Area/Zone.
 *
 * Validation order (pinned by tests):
 *   1. unknown Area              → 404 AREA_NOT_FOUND
 *   2. INACTIVE Area             → 400 AREA_NOT_AVAILABLE
 *   3. duplicate code for Area   → 409 ROOM_CODE_ALREADY_EXISTS
 *
 * The `(area_id, code)` unique constraint remains the final authority — it
 * also covers the race between the pre-check and the INSERT. Client/Building
 * context is preserved implicitly: a Room carries only `area_id`, so
 * ownership is always derived Room → Area → Floor → Building → Property →
 * Client.
 */
export async function createRoom(input: CreateRoomInput): Promise<PublicRoom> {
  const area = await areaRepository.findById(input.areaId);
  if (!area) {
    throw areaNotFoundError();
  }
  if (area.status !== 'ACTIVE') {
    throw roomAreaInactiveError();
  }

  const existing = await roomRepository.findByCodeForArea(
    input.areaId,
    input.code,
  );
  if (existing) {
    throw roomCodeAlreadyExistsError();
  }

  const newRoom: NewRoom = {
    areaId: input.areaId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await roomRepository.createRoom(newRoom);
    return toPublicRoom(record);
  } catch (error) {
    if (isRoomCodeUniqueViolation(error)) {
      throw roomCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getRoomById(id: string): Promise<PublicRoom> {
  const record = await roomRepository.findById(id);
  if (!record) {
    throw roomNotFoundError();
  }
  return toPublicRoom(record);
}

/**
 * Lists the Rooms of one Area/Zone.
 *
 * The Area is validated first (unknown Area → 404 rather than an empty list)
 * and the query is scoped to `area_id`, so another Area's rooms are never
 * reachable through this route.
 */
export async function listRoomsByArea(areaId: string): Promise<PublicRoom[]> {
  const area = await areaRepository.findById(areaId);
  if (!area) {
    throw areaNotFoundError();
  }

  const records = await roomRepository.listByArea(areaId);
  return records.map(toPublicRoom);
}

/**
 * Resolves the Client that authoritatively owns a Room, walking
 * Room → Area → Floor → Building → Property → Client. This is the single
 * place Room Type assignment derives Client context, so classification can
 * never drift from BE-02 ownership.
 */
export async function resolveRoomClientId(
  record: Pick<RoomRecord, 'areaId'>,
): Promise<string> {
  const buildingId = await resolveAreaBuildingId(record.areaId);
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    // Areas always point at a real chain (enforced by FKs), so this is a
    // data-integrity fault rather than a caller error.
    throw buildingNotFoundError();
  }
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  return property.clientId;
}

/**
 * Partially updates a Room (name, description, status, roomTypeId).
 *
 * `areaId` and `code` are deliberately immutable — a Room never migrates
 * between Areas, and its code is the stable identifier deeper structure
 * levels (BE-04F+) will reference.
 *
 * Room Type assignment (`roomTypeId` set to an id; null clears it) is
 * classification only — it never changes the Room's position in the
 * hierarchy. Validation order (pinned by tests):
 *   1. unknown Room Type                  → 404 ROOM_TYPE_NOT_FOUND
 *   2. Room Type of a different Client    → 400 ROOM_TYPE_CLIENT_MISMATCH
 *      (checked BEFORE status, so a foreign Client's reference-data
 *      lifecycle is never probeable)
 *   3. INACTIVE Room Type                 → 400 ROOM_TYPE_INACTIVE
 *      (existing classifications survive deactivation; only NEW
 *      assignments are refused)
 */
export async function updateRoom(
  id: string,
  input: UpdateRoomInput,
): Promise<PublicRoom> {
  const existing = await roomRepository.findById(id);
  if (!existing) {
    throw roomNotFoundError();
  }

  if (input.roomTypeId !== undefined && input.roomTypeId !== null) {
    const roomType = await roomTypeRepository.findById(input.roomTypeId);
    if (!roomType) {
      throw roomTypeNotFoundError();
    }

    const roomClientId = await resolveRoomClientId(existing);
    if (roomType.clientId !== roomClientId) {
      throw roomTypeClientMismatchError();
    }

    if (roomType.status !== 'ACTIVE') {
      throw roomTypeInactiveError();
    }
  }

  const record = await roomRepository.updateRoom(id, input);
  return toPublicRoom(record as RoomRecord);
}

/**
 * Activates or deactivates a Room. Deactivating is not a delete: the Room
 * (and, in later PARTs, the structure beneath it) remains persisted for
 * history; it simply stops being an active operational unit.
 */
export async function updateRoomStatus(
  id: string,
  input: UpdateRoomStatusInput,
): Promise<PublicRoom> {
  const existing = await roomRepository.findById(id);
  if (!existing) {
    throw roomNotFoundError();
  }

  const record = await roomRepository.updateStatus(id, input.status);
  return toPublicRoom(record as RoomRecord);
}

function isRoomCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'rooms_area_code_unique'
  );
}

export const roomService = {
  createRoom,
  getRoomById,
  listRoomsByArea,
  resolveAreaBuildingId,
  resolveRoomClientId,
  toPublicRoom,
  updateRoom,
  updateRoomStatus,
};
