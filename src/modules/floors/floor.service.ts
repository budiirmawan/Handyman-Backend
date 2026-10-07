import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  floorBuildingInactiveError,
  floorCodeAlreadyExistsError,
  floorNotFoundError,
} from './floor.errors';
import { floorRepository } from './floor.repository';
import type {
  CreateFloorInput,
  FloorRecord,
  FloorStatus,
  NewFloor,
  PublicFloor,
  UpdateFloorInput,
  UpdateFloorStatusInput,
} from './floor.types';

export function toPublicFloor(record: FloorRecord): PublicFloor {
  return {
    id: record.id,
    buildingId: record.buildingId,
    code: record.code,
    name: record.name,
    levelNumber: record.levelNumber,
    description: record.description,
    status: record.status,
  };
}

/**
 * Creates a Floor under a Building.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building            → 404 BUILDING_NOT_FOUND
 *   2. INACTIVE Building           → 400 BUILDING_NOT_AVAILABLE
 *   3. duplicate code for Building → 409 FLOOR_CODE_ALREADY_EXISTS
 *
 * The `(building_id, code)` unique constraint remains the final authority —
 * it also covers the race between the pre-check and the INSERT. Client context
 * is preserved implicitly: a Floor carries only `building_id`, so ownership is
 * always derived Floor → Building → Property → Client (single source of
 * truth; no cross-Client drift is possible).
 */
export async function createFloor(input: CreateFloorInput): Promise<PublicFloor> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  if (building.status !== 'ACTIVE') {
    throw floorBuildingInactiveError();
  }

  const existing = await floorRepository.findByCodeForBuilding(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw floorCodeAlreadyExistsError();
  }

  const newFloor: NewFloor = {
    buildingId: input.buildingId,
    code: input.code,
    name: input.name,
    levelNumber: input.levelNumber,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await floorRepository.createFloor(newFloor);
    return toPublicFloor(record);
  } catch (error) {
    if (isFloorCodeUniqueViolation(error)) {
      throw floorCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getFloorById(id: string): Promise<PublicFloor> {
  const record = await floorRepository.findById(id);
  if (!record) {
    throw floorNotFoundError();
  }
  return toPublicFloor(record);
}

/**
 * Lists the Floors of one Building, ordered by level.
 *
 * The Building is validated first (unknown Building → 404 rather than an
 * empty list) and the query is scoped to `building_id`, so another Building's
 * floors are never reachable through this route.
 */
export async function listFloorsByBuilding(
  buildingId: string,
): Promise<PublicFloor[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const records = await floorRepository.listByBuilding(buildingId);
  return records.map(toPublicFloor);
}

/**
 * Partially updates a Floor (name, levelNumber, description, status).
 *
 * `buildingId` and `code` are deliberately immutable — a Floor never migrates
 * between Buildings, and its code is the stable identifier other structure
 * levels (BE-04C+) will reference.
 */
export async function updateFloor(
  id: string,
  input: UpdateFloorInput,
): Promise<PublicFloor> {
  const existing = await floorRepository.findById(id);
  if (!existing) {
    throw floorNotFoundError();
  }

  const record = await floorRepository.updateFloor(id, input);
  return toPublicFloor(record as FloorRecord);
}

/**
 * Activates or deactivates a Floor. Deactivating is not a delete: the Floor
 * (and, in later PARTs, the structure beneath it) remains persisted for
 * history; it simply stops being an active structure level.
 */
export async function updateFloorStatus(
  id: string,
  input: UpdateFloorStatusInput,
): Promise<PublicFloor> {
  const existing = await floorRepository.findById(id);
  if (!existing) {
    throw floorNotFoundError();
  }

  const status: FloorStatus = input.status;
  const record = await floorRepository.updateStatus(id, status);
  return toPublicFloor(record as FloorRecord);
}

function isFloorCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'floors_building_code_unique'
  );
}

export const floorService = {
  createFloor,
  getFloorById,
  listFloorsByBuilding,
  toPublicFloor,
  updateFloor,
  updateFloorStatus,
};
