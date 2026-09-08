import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import {
  roomTypeCodeAlreadyExistsError,
  roomTypeNotFoundError,
} from './room-type.errors';
import { roomTypeRepository } from './room-type.repository';
import type {
  CreateRoomTypeInput,
  NewRoomType,
  PublicRoomType,
  RoomTypeRecord,
  UpdateRoomTypeInput,
  UpdateRoomTypeStatusInput,
} from './room-type.types';

export function toPublicRoomType(record: RoomTypeRecord): PublicRoomType {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

/**
 * Creates a Room Type in a Client's reference catalog.
 *
 * Validation order (pinned by tests, matching the BE-03D1 Skill precedent):
 *   1. unknown Client              → 404 CLIENT_NOT_FOUND
 *   2. INACTIVE Client             → 400 CLIENT_INACTIVE
 *   3. duplicate code for Client   → 409 ROOM_TYPE_CODE_ALREADY_EXISTS
 *
 * The `(client_id, code)` unique constraint remains the final authority — it
 * also covers the race between the pre-check and the INSERT.
 */
export async function createRoomType(
  input: CreateRoomTypeInput,
): Promise<PublicRoomType> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const existing = await roomTypeRepository.findByCodeForClient(
    input.clientId,
    input.code,
  );
  if (existing) {
    throw roomTypeCodeAlreadyExistsError();
  }

  const newRoomType: NewRoomType = {
    clientId: input.clientId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await roomTypeRepository.createRoomType(newRoomType);
    return toPublicRoomType(record);
  } catch (error) {
    if (isRoomTypeCodeUniqueViolation(error)) {
      throw roomTypeCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getRoomTypeById(id: string): Promise<PublicRoomType> {
  const record = await roomTypeRepository.findById(id);
  if (!record) {
    throw roomTypeNotFoundError();
  }
  return toPublicRoomType(record);
}

/**
 * Lists the Room Types of one Client's reference catalog.
 *
 * The Client is validated first (unknown Client → 404 rather than an empty
 * list) and the query is scoped to `client_id`, so another Client's catalog
 * is never reachable through this route.
 */
export async function listRoomTypesByClient(
  clientId: string,
): Promise<PublicRoomType[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }

  const records = await roomTypeRepository.listByClient(clientId);
  return records.map(toPublicRoomType);
}

/**
 * Partially updates a Room Type (name, description, status).
 *
 * `clientId` and `code` are deliberately immutable — reference data never
 * migrates between Clients, and its code is the stable identifier Rooms
 * point at.
 */
export async function updateRoomType(
  id: string,
  input: UpdateRoomTypeInput,
): Promise<PublicRoomType> {
  const existing = await roomTypeRepository.findById(id);
  if (!existing) {
    throw roomTypeNotFoundError();
  }

  const record = await roomTypeRepository.updateRoomType(id, input);
  return toPublicRoomType(record as RoomTypeRecord);
}

/**
 * Activates or deactivates a Room Type. Deactivating is not a delete:
 * existing Room classifications survive; the Room Type simply stops being
 * assignable to further Rooms.
 */
export async function updateRoomTypeStatus(
  id: string,
  input: UpdateRoomTypeStatusInput,
): Promise<PublicRoomType> {
  const existing = await roomTypeRepository.findById(id);
  if (!existing) {
    throw roomTypeNotFoundError();
  }

  const record = await roomTypeRepository.updateStatus(id, input.status);
  return toPublicRoomType(record as RoomTypeRecord);
}

function isRoomTypeCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'room_types_client_code_unique'
  );
}

export const roomTypeService = {
  createRoomType,
  getRoomTypeById,
  listRoomTypesByClient,
  toPublicRoomType,
  updateRoomType,
  updateRoomTypeStatus,
};
