import { floorNotFoundError, floorRepository } from '../floors';
import {
  areaCodeAlreadyExistsError,
  areaFloorInactiveError,
  areaNotFoundError,
} from './area.errors';
import { areaRepository } from './area.repository';
import type {
  AreaRecord,
  CreateAreaInput,
  NewArea,
  PublicArea,
  UpdateAreaInput,
  UpdateAreaStatusInput,
} from './area.types';

export function toPublicArea(record: AreaRecord): PublicArea {
  return {
    id: record.id,
    floorId: record.floorId,
    code: record.code,
    name: record.name,
    type: record.type,
    description: record.description,
    status: record.status,
  };
}

/**
 * Resolves the Building that hosts a Floor (unknown Floor → 404). This is the
 * single place Area routes walk Floor → Building, so Area isolation can never
 * drift from Building isolation.
 */
export async function resolveFloorBuildingId(floorId: string): Promise<string> {
  const floor = await floorRepository.findById(floorId);
  if (!floor) {
    throw floorNotFoundError();
  }
  return floor.buildingId;
}

/**
 * Creates an Area under a Floor.
 *
 * Validation order (pinned by tests):
 *   1. unknown Floor              → 404 FLOOR_NOT_FOUND
 *   2. INACTIVE Floor             → 400 FLOOR_NOT_AVAILABLE
 *   3. duplicate code for Floor   → 409 AREA_CODE_ALREADY_EXISTS
 *
 * The `(floor_id, code)` unique constraint remains the final authority — it
 * also covers the race between the pre-check and the INSERT. Client/Building
 * context is preserved implicitly: an Area carries only `floor_id`, so
 * ownership is always derived Area → Floor → Building → Property → Client.
 */
export async function createArea(input: CreateAreaInput): Promise<PublicArea> {
  const floor = await floorRepository.findById(input.floorId);
  if (!floor) {
    throw floorNotFoundError();
  }
  if (floor.status !== 'ACTIVE') {
    throw areaFloorInactiveError();
  }

  const existing = await areaRepository.findByCodeForFloor(
    input.floorId,
    input.code,
  );
  if (existing) {
    throw areaCodeAlreadyExistsError();
  }

  const newArea: NewArea = {
    floorId: input.floorId,
    code: input.code,
    name: input.name,
    type: input.type ?? 'AREA',
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await areaRepository.createArea(newArea);
    return toPublicArea(record);
  } catch (error) {
    if (isAreaCodeUniqueViolation(error)) {
      throw areaCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getAreaById(id: string): Promise<PublicArea> {
  const record = await areaRepository.findById(id);
  if (!record) {
    throw areaNotFoundError();
  }
  return toPublicArea(record);
}

/**
 * Lists the Areas of one Floor.
 *
 * The Floor is validated first (unknown Floor → 404 rather than an empty
 * list) and the query is scoped to `floor_id`, so another Floor's areas are
 * never reachable through this route.
 */
export async function listAreasByFloor(floorId: string): Promise<PublicArea[]> {
  const floor = await floorRepository.findById(floorId);
  if (!floor) {
    throw floorNotFoundError();
  }

  const records = await areaRepository.listByFloor(floorId);
  return records.map(toPublicArea);
}

/**
 * Partially updates an Area (name, type, description, status).
 *
 * `floorId` and `code` are deliberately immutable — an Area never migrates
 * between Floors, and its code is the stable identifier deeper structure
 * levels (BE-04D+) will reference.
 */
export async function updateArea(
  id: string,
  input: UpdateAreaInput,
): Promise<PublicArea> {
  const existing = await areaRepository.findById(id);
  if (!existing) {
    throw areaNotFoundError();
  }

  const record = await areaRepository.updateArea(id, input);
  return toPublicArea(record as AreaRecord);
}

/**
 * Activates or deactivates an Area. Deactivating is not a delete: the Area
 * (and, in later PARTs, the structure beneath it) remains persisted for
 * history; it simply stops being an active operational grouping.
 */
export async function updateAreaStatus(
  id: string,
  input: UpdateAreaStatusInput,
): Promise<PublicArea> {
  const existing = await areaRepository.findById(id);
  if (!existing) {
    throw areaNotFoundError();
  }

  const record = await areaRepository.updateStatus(id, input.status);
  return toPublicArea(record as AreaRecord);
}

function isAreaCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'areas_floor_code_unique'
  );
}

export const areaService = {
  createArea,
  getAreaById,
  listAreasByFloor,
  resolveFloorBuildingId,
  toPublicArea,
  updateArea,
  updateAreaStatus,
};
