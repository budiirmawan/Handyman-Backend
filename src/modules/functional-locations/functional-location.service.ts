import { buildingNotFoundError, buildingRepository } from '../buildings';
import { resolveRoomBuildingId } from '../spaces';
import { spaceNotFoundError, spaceRepository } from '../spaces';
import {
  functionalLocationBuildingInactiveError,
  functionalLocationCodeAlreadyExistsError,
  functionalLocationNotFoundError,
  functionalLocationSpaceMismatchError,
} from './functional-location.errors';
import { functionalLocationRepository } from './functional-location.repository';
import type {
  CreateFunctionalLocationInput,
  FunctionalLocationRecord,
  NewFunctionalLocation,
  PublicFunctionalLocation,
  UpdateFunctionalLocationInput,
  UpdateFunctionalLocationStatusInput,
} from './functional-location.types';

export function toPublicFunctionalLocation(
  record: FunctionalLocationRecord,
): PublicFunctionalLocation {
  return {
    id: record.id,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

/**
 * Validates that a referenced Space exists and resolves to the SAME Building
 * through the physical hierarchy (Space → Room → Area → Floor → Building).
 *
 * Order (pinned by tests): unknown Space → 404 SPACE_NOT_FOUND, then a Space
 * of a different Building → 400 FUNCTIONAL_LOCATION_SPACE_MISMATCH. The
 * hierarchy itself is the authority — no parallel parent bookkeeping.
 */
async function assertSpaceInBuilding(
  spaceId: string,
  buildingId: string,
): Promise<void> {
  const space = await spaceRepository.findById(spaceId);
  if (!space) {
    throw spaceNotFoundError();
  }

  const spaceBuildingId = await resolveRoomBuildingId(space.roomId);
  if (spaceBuildingId !== buildingId) {
    throw functionalLocationSpaceMismatchError();
  }
}

/**
 * Creates a Functional Location under a Building, optionally pinned to a
 * Space of that same Building.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                  → 404 BUILDING_NOT_FOUND
 *   2. INACTIVE Building                 → 400 BUILDING_NOT_AVAILABLE
 *   3. unknown Space (when provided)     → 404 SPACE_NOT_FOUND
 *   4. Space of a different Building     → 400 FUNCTIONAL_LOCATION_SPACE_MISMATCH
 *   5. duplicate code for Building       → 409 FUNCTIONAL_LOCATION_CODE_ALREADY_EXISTS
 *
 * The `(building_id, code)` unique constraint remains the final authority —
 * it also covers the race between the pre-check and the INSERT.
 */
export async function createFunctionalLocation(
  input: CreateFunctionalLocationInput,
): Promise<PublicFunctionalLocation> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  if (building.status !== 'ACTIVE') {
    throw functionalLocationBuildingInactiveError();
  }

  if (input.spaceId !== undefined) {
    await assertSpaceInBuilding(input.spaceId, input.buildingId);
  }

  const existing = await functionalLocationRepository.findByCodeForBuilding(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw functionalLocationCodeAlreadyExistsError();
  }

  const newFunctionalLocation: NewFunctionalLocation = {
    buildingId: input.buildingId,
    spaceId: input.spaceId ?? null,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await functionalLocationRepository.createFunctionalLocation(
      newFunctionalLocation,
    );
    return toPublicFunctionalLocation(record);
  } catch (error) {
    if (isFunctionalLocationCodeUniqueViolation(error)) {
      throw functionalLocationCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getFunctionalLocationById(
  id: string,
): Promise<PublicFunctionalLocation> {
  const record = await functionalLocationRepository.findById(id);
  if (!record) {
    throw functionalLocationNotFoundError();
  }
  return toPublicFunctionalLocation(record);
}

/**
 * Lists the Functional Locations of one Building, optionally filtered to a
 * single Space (`?spaceId=` — no separate Space-nested API surface needed).
 *
 * The Building is validated first (unknown Building → 404 rather than an
 * empty list). When the filter is present, the Space must exist and belong
 * to this Building — so the filter can never be used to probe another
 * Building's structure. Queries stay scoped to `building_id`.
 */
export async function listFunctionalLocationsByBuilding(
  buildingId: string,
  spaceId?: string,
): Promise<PublicFunctionalLocation[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  if (spaceId !== undefined) {
    await assertSpaceInBuilding(spaceId, buildingId);
  }

  const records = await functionalLocationRepository.listByBuilding(
    buildingId,
    spaceId,
  );
  return records.map(toPublicFunctionalLocation);
}

/**
 * Partially updates a Functional Location (name, description, status,
 * spaceId — a UUID re-pins the physical placement, null clears it back to
 * Building level).
 *
 * `buildingId` and `code` are deliberately immutable — a Functional Location
 * never migrates between Buildings, and its code is the stable operational
 * identifier other domains will reference. A re-pinned Space must belong to
 * the same Building (404 unknown / 400 mismatch, same as create).
 */
export async function updateFunctionalLocation(
  id: string,
  input: UpdateFunctionalLocationInput,
): Promise<PublicFunctionalLocation> {
  const existing = await functionalLocationRepository.findById(id);
  if (!existing) {
    throw functionalLocationNotFoundError();
  }

  if (input.spaceId !== undefined && input.spaceId !== null) {
    await assertSpaceInBuilding(input.spaceId, existing.buildingId);
  }

  const record = await functionalLocationRepository.updateFunctionalLocation(
    id,
    input,
  );
  return toPublicFunctionalLocation(record as FunctionalLocationRecord);
}

/**
 * Activates or deactivates a Functional Location. Deactivating is not a
 * delete: the reference remains persisted for history; it simply stops being
 * an active operational location.
 */
export async function updateFunctionalLocationStatus(
  id: string,
  input: UpdateFunctionalLocationStatusInput,
): Promise<PublicFunctionalLocation> {
  const existing = await functionalLocationRepository.findById(id);
  if (!existing) {
    throw functionalLocationNotFoundError();
  }

  const record = await functionalLocationRepository.updateStatus(
    id,
    input.status,
  );
  return toPublicFunctionalLocation(record as FunctionalLocationRecord);
}

function isFunctionalLocationCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'functional_locations_building_code_unique'
  );
}

export const functionalLocationService = {
  createFunctionalLocation,
  getFunctionalLocationById,
  listFunctionalLocationsByBuilding,
  toPublicFunctionalLocation,
  updateFunctionalLocation,
  updateFunctionalLocationStatus,
};
