import {
  buildingNotFoundError,
  buildingRepository,
  toPublicBuilding,
  type PublicBuilding,
} from '../buildings';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  campusCodeAlreadyExistsError,
  campusInactiveError,
  campusNotFoundError,
  campusPropertyInactiveError,
  campusPropertyMismatchError,
} from './campus.errors';
import { campusRepository } from './campus.repository';
import type {
  CampusRecord,
  CreateCampusInput,
  NewCampus,
  PublicCampus,
  SetBuildingCampusInput,
  UpdateCampusInput,
  UpdateCampusStatusInput,
} from './campus.types';

export function toPublicCampus(record: CampusRecord): PublicCampus {
  return {
    id: record.id,
    propertyId: record.propertyId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
  };
}

/**
 * Creates a Campus under a Property.
 *
 * Validation order (pinned by tests):
 *   1. unknown Property             → 404 PROPERTY_NOT_FOUND
 *   2. INACTIVE Property            → 400 PROPERTY_INACTIVE
 *   3. duplicate code for Property  → 409 CAMPUS_CODE_ALREADY_EXISTS
 *
 * The `(property_id, code)` unique constraint remains the final authority —
 * it also covers the race between the pre-check and the INSERT. Client
 * context is preserved implicitly: a Campus carries only `property_id`, so
 * ownership is always derived Campus → Property → Client.
 */
export async function createCampus(
  input: CreateCampusInput,
): Promise<PublicCampus> {
  const property = await propertyRepository.findById(input.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  if (property.status !== 'ACTIVE') {
    throw campusPropertyInactiveError();
  }

  const existing = await campusRepository.findByCodeForProperty(
    input.propertyId,
    input.code,
  );
  if (existing) {
    throw campusCodeAlreadyExistsError();
  }

  const newCampus: NewCampus = {
    propertyId: input.propertyId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await campusRepository.createCampus(newCampus);
    return toPublicCampus(record);
  } catch (error) {
    if (isCampusCodeUniqueViolation(error)) {
      throw campusCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getCampusById(id: string): Promise<PublicCampus> {
  const record = await campusRepository.findById(id);
  if (!record) {
    throw campusNotFoundError();
  }
  return toPublicCampus(record);
}

/**
 * Lists the Campuses of one Property.
 *
 * The Property is validated first (unknown Property → 404 rather than an
 * empty list) and the query is scoped to `property_id`, so another Property's
 * campuses are never reachable through this route. A Property that uses no
 * campuses simply returns an empty list — the plain Property → Building chain
 * stays fully supported.
 */
export async function listCampusesByProperty(
  propertyId: string,
): Promise<PublicCampus[]> {
  const property = await propertyRepository.findById(propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }

  const records = await campusRepository.listByProperty(propertyId);
  return records.map(toPublicCampus);
}

/**
 * Partially updates a Campus (name, description, status).
 *
 * `propertyId` and `code` are deliberately immutable — a Campus never
 * migrates between Properties, and its code is the stable identifier.
 */
export async function updateCampus(
  id: string,
  input: UpdateCampusInput,
): Promise<PublicCampus> {
  const existing = await campusRepository.findById(id);
  if (!existing) {
    throw campusNotFoundError();
  }

  const record = await campusRepository.updateCampus(id, input);
  return toPublicCampus(record as CampusRecord);
}

/**
 * Activates or deactivates a Campus. Deactivating is not a delete: the Campus
 * and its existing Building associations remain persisted — the Campus simply
 * stops accepting NEW Building associations.
 */
export async function updateCampusStatus(
  id: string,
  input: UpdateCampusStatusInput,
): Promise<PublicCampus> {
  const existing = await campusRepository.findById(id);
  if (!existing) {
    throw campusNotFoundError();
  }

  const record = await campusRepository.updateStatus(id, input.status);
  return toPublicCampus(record as CampusRecord);
}

/**
 * Associates a Building with a Campus (or detaches it with `campusId: null`).
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                     → 404 BUILDING_NOT_FOUND
 *   2. unknown Campus                       → 404 CAMPUS_NOT_FOUND
 *   3. Campus of a different Property       → 400 CAMPUS_PROPERTY_MISMATCH
 *      (checked BEFORE status, so a foreign Campus's lifecycle state is
 *      never probeable across the Property boundary)
 *   4. INACTIVE Campus                      → 400 CAMPUS_INACTIVE
 *      (inactive Campuses keep existing associations but accept no new ones)
 *
 * Detaching is always allowed while the Building exists — returning a
 * Building to the plain Property → Building chain is never blocked by the
 * Campus's state.
 */
export async function setBuildingCampus(
  buildingId: string,
  input: SetBuildingCampusInput,
): Promise<PublicBuilding> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  if (input.campusId === null) {
    const detached = await buildingRepository.updateCampusReference(
      buildingId,
      null,
    );
    return toPublicBuilding(detached!);
  }

  const campus = await campusRepository.findById(input.campusId);
  if (!campus) {
    throw campusNotFoundError();
  }

  if (campus.propertyId !== building.propertyId) {
    throw campusPropertyMismatchError();
  }

  if (campus.status !== 'ACTIVE') {
    throw campusInactiveError();
  }

  const updated = await buildingRepository.updateCampusReference(
    buildingId,
    campus.id,
  );
  return toPublicBuilding(updated!);
}

function isCampusCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'campuses_property_code_unique'
  );
}

export const campusService = {
  createCampus,
  getCampusById,
  listCampusesByProperty,
  setBuildingCampus,
  toPublicCampus,
  updateCampus,
  updateCampusStatus,
};
