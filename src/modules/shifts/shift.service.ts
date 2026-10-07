import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  shiftBuildingClientMismatchError,
  shiftCodeAlreadyExistsError,
  shiftNotFoundError,
} from './shift.errors';
import { shiftRepository } from './shift.repository';
import type {
  CreateShiftInput,
  NewShift,
  PublicShift,
  ShiftRecord,
  ShiftStatus,
} from './shift.types';

export function toPublicShift(record: ShiftRecord): PublicShift {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    code: record.code,
    name: record.name,
    startTime: record.startTime,
    endTime: record.endTime,
    status: record.status,
  };
}

/**
 * Resolves the Client that authoritatively owns a Building.
 *
 * A Building carries no `client_id`: ownership is derived Building → Property
 * → Client (BE-02). This is the single place that walks that chain, so Shift
 * isolation can never drift from Building isolation.
 */
export async function resolveBuildingClientId(
  buildingId: string,
): Promise<string> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    // A Building always points at a real Property (enforced by FK), so this is
    // a data-integrity fault rather than a caller error.
    throw propertyNotFoundError();
  }

  return property.clientId;
}

/**
 * Creates a Shift under a Building.
 *
 * Validation order is deliberate and is what the tests pin down:
 *   1. unknown Client                → 404
 *   2. INACTIVE Client               → 400
 *   3. unknown Building              → 404
 *   4. Building owned by another Client → 400 (before any uniqueness work, so a
 *      foreign Building's shift codes are never probeable)
 *   5. duplicate code for Building   → 409
 */
export async function createShift(
  input: CreateShiftInput,
): Promise<PublicShift> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  const buildingClientId = await resolveBuildingClientId(input.buildingId);
  if (buildingClientId !== input.clientId) {
    throw shiftBuildingClientMismatchError();
  }

  const existing = await shiftRepository.findByCodeForBuilding(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw shiftCodeAlreadyExistsError();
  }

  const newShift: NewShift = {
    clientId: input.clientId,
    buildingId: input.buildingId,
    code: input.code,
    name: input.name,
    startTime: input.startTime,
    endTime: input.endTime,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await shiftRepository.create(newShift);
    return toPublicShift(record);
  } catch (error) {
    // The (building_id, code) unique key is the final authority: it also covers
    // the race between the pre-check above and the INSERT.
    if (isShiftCodeUniqueViolation(error)) {
      throw shiftCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getShiftById(id: string): Promise<PublicShift> {
  const record = await shiftRepository.findById(id);
  if (!record) {
    throw shiftNotFoundError();
  }
  return toPublicShift(record);
}

/**
 * Lists the Shifts operated at one Building.
 *
 * The Building is validated first (unknown Building → 404 rather than an empty
 * list) and the query itself is scoped to `building_id`, so another Building's
 * shifts are never reachable through this route.
 */
export async function listShiftsByBuilding(
  buildingId: string,
): Promise<PublicShift[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const records = await shiftRepository.listByBuilding(buildingId);
  return records.map(toPublicShift);
}

/**
 * Activates or deactivates a Shift. Deactivating is not a delete: existing
 * assignments are retained, they simply stop being assignable targets.
 */
export async function updateShiftStatus(
  id: string,
  status: ShiftStatus,
): Promise<PublicShift> {
  const record = await shiftRepository.updateStatus(id, status);
  if (!record) {
    throw shiftNotFoundError();
  }
  return toPublicShift(record);
}

function isShiftCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'shifts_building_code_unique'
  );
}

export const shiftService = {
  createShift,
  getShiftById,
  listShiftsByBuilding,
  resolveBuildingClientId,
  toPublicShift,
  updateShiftStatus,
};
