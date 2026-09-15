import { getPool } from '../../database';
import { areaRepository, areaNotFoundError } from '../areas';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { floorNotFoundError, floorRepository } from '../floors';
import { propertyNotFoundError, propertyRepository } from '../properties';
import { roomNotFoundError, roomRepository } from '../rooms';
import { spaceNotFoundError, spaceRepository } from '../spaces';
import { assertMeterUtilityConfiguration } from '../utility-type-configurations/utility-type-configuration.service';
import {
  utilityMeterBuildingInactiveError,
  utilityMeterCodeAlreadyExistsError,
  utilityMeterLocationMismatchError,
  utilityMeterNotFoundError,
  utilityMeterUomClientMismatchError,
  utilityMeterUomInactiveError,
  utilityMeterUomNotFoundError,
} from './utility-meter.errors';
import { utilityMeterRepository } from './utility-meter.repository';
import type {
  CreateUtilityMeterInput,
  NewUtilityMeter,
  PublicUtilityMeter,
  UpdateUtilityMeterInput,
  UpdateUtilityMeterStatusInput,
  UtilityMeterFilters,
  UtilityMeterRecord,
} from './utility-meter.types';

/**
 * BE-18A — Meter Master service. The backend authority for Meter identity.
 *
 * Isolation: `clientId` is NEVER accepted from the caller — it is derived
 * through Building → Property → Client, and every operation additionally
 * asserts the actor's explicit BE-02G Building access.
 *
 * Reuse: UOM validation reads the BE-07 `units_of_measure` table directly
 * (same Client + ACTIVE); Space / Functional Location are resolved through
 * the authoritative BE-04 hierarchy. No location or measurement data is
 * copied into BE-18.
 */

type UomContext = { id: string; code: string; name: string; symbol: string };

export function toPublicUtilityMeter(
  record: UtilityMeterRecord,
  uom: UomContext | null = null,
): PublicUtilityMeter {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    functionalLocationId: record.functionalLocationId,
    code: record.code,
    name: record.name,
    utilityType: record.utilityType,
    purpose: record.purpose,
    uomId: record.uomId,
    serialNumber: record.serialNumber,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    uom,
  };
}

/** Resolves the authoritative Client owner of a Building (BE-02 chain). */
async function resolveBuildingContext(
  buildingId: string,
): Promise<{ clientId: string; status: string }> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  return { clientId: property.clientId, status: building.status };
}

/** BE-02G — an actor may only operate inside an explicitly assigned Building. */
async function assertBuildingAccess(
  actorUserId: string | undefined,
  buildingId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertClientAccess(
  actorUserId: string | undefined,
  clientId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

/** Resolves Space → Room → Area → Floor → Building (BE-04 authority). */
async function resolveSpaceBuildingId(spaceId: string): Promise<string> {
  const space = await spaceRepository.findById(spaceId);
  if (!space) {
    throw spaceNotFoundError();
  }
  const room = await roomRepository.findById(space.roomId);
  if (!room) {
    throw roomNotFoundError();
  }
  const area = await areaRepository.findById(room.areaId);
  if (!area) {
    throw areaNotFoundError();
  }
  const floor = await floorRepository.findById(area.floorId);
  if (!floor) {
    throw floorNotFoundError();
  }
  return floor.buildingId;
}

/**
 * Validates optional location refinements against the meter's Building.
 * Order: unknown reference → 404, wrong Building → 400 LOCATION_MISMATCH,
 * then Space/Functional Location cross-consistency.
 */
async function assertLocationReferences(
  buildingId: string,
  locations: {
    spaceId?: string | null;
    functionalLocationId?: string | null;
  },
): Promise<void> {
  if (locations.spaceId) {
    const spaceBuildingId = await resolveSpaceBuildingId(locations.spaceId);
    if (spaceBuildingId !== buildingId) {
      throw utilityMeterLocationMismatchError(
        'The referenced space does not belong to this building.',
      );
    }
  }

  if (locations.functionalLocationId) {
    const functionalLocation = await functionalLocationRepository.findById(
      locations.functionalLocationId,
    );
    if (!functionalLocation) {
      throw functionalLocationNotFoundError();
    }
    if (functionalLocation.buildingId !== buildingId) {
      throw utilityMeterLocationMismatchError(
        'The referenced functional location does not belong to this building.',
      );
    }
    if (
      locations.spaceId &&
      functionalLocation.spaceId !== null &&
      functionalLocation.spaceId !== locations.spaceId
    ) {
      throw utilityMeterLocationMismatchError(
        'The referenced functional location does not belong to the referenced space.',
      );
    }
  }
}

/** BE-07 reuse: the UOM must exist, belong to the same Client, and be ACTIVE. */
async function assertUom(uomId: string, clientId: string): Promise<UomContext> {
  const result = await getPool().query<{
    id: string;
    client_id: string;
    code: string;
    name: string;
    symbol: string;
    status: string;
  }>(
    'SELECT id, client_id, code, name, symbol, status FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  const row = result.rows[0];
  if (!row) {
    throw utilityMeterUomNotFoundError();
  }
  if (row.client_id !== clientId) {
    throw utilityMeterUomClientMismatchError();
  }
  if (row.status !== 'ACTIVE') {
    throw utilityMeterUomInactiveError();
  }
  return { id: row.id, code: row.code, name: row.name, symbol: row.symbol };
}

async function loadUomContexts(
  uomIds: readonly string[],
): Promise<Map<string, UomContext>> {
  const map = new Map<string, UomContext>();
  const unique = [...new Set(uomIds)];
  if (unique.length === 0) {
    return map;
  }
  const result = await getPool().query<{
    id: string;
    code: string;
    name: string;
    symbol: string;
  }>('SELECT id, code, name, symbol FROM units_of_measure WHERE id = ANY($1)', [
    unique,
  ]);
  for (const row of result.rows) {
    map.set(row.id, {
      id: row.id,
      code: row.code,
      name: row.name,
      symbol: row.symbol,
    });
  }
  return map;
}

/**
 * Registers a Meter under a Building.
 *
 * Validation order:
 *   1. unknown Building                  → 404 BUILDING_NOT_FOUND
 *   2. INACTIVE Building                 → 400 BUILDING_NOT_AVAILABLE
 *   3. no Building access                → 403 BUILDING_ACCESS_DENIED
 *   4. duplicate code for Client         → 409 UTILITY_METER_CODE_ALREADY_EXISTS
 *   5. unknown UOM                       → 404 UTILITY_METER_UOM_NOT_FOUND
 *   6. UOM of another Client             → 400 UTILITY_METER_UOM_CLIENT_MISMATCH
 *   7. INACTIVE UOM                      → 400 UTILITY_METER_UOM_INACTIVE
 *   8. unknown Space / Functional Loc.   → 404
 *   9. location of another Building      → 400 UTILITY_METER_LOCATION_MISMATCH
 */
export async function createUtilityMeter(
  input: CreateUtilityMeterInput,
  actorUserId?: string,
): Promise<PublicUtilityMeter> {
  const { clientId, status: buildingStatus } = await resolveBuildingContext(
    input.buildingId,
  );
  if (buildingStatus !== 'ACTIVE') {
    throw utilityMeterBuildingInactiveError();
  }

  await assertBuildingAccess(actorUserId, input.buildingId);

  const existing = await utilityMeterRepository.findByCodeForClient(
    clientId,
    input.code,
  );
  if (existing) {
    throw utilityMeterCodeAlreadyExistsError();
  }

  const uom = await assertUom(input.uomId, clientId);

  // BE-18B — every Meter must carry a valid utility type / UOM combination.
  await assertMeterUtilityConfiguration(clientId, input.utilityType, input.uomId);

  await assertLocationReferences(input.buildingId, {
    spaceId: input.spaceId,
    functionalLocationId: input.functionalLocationId,
  });

  const newMeter: NewUtilityMeter = {
    clientId,
    buildingId: input.buildingId,
    spaceId: input.spaceId ?? null,
    functionalLocationId: input.functionalLocationId ?? null,
    code: input.code,
    name: input.name,
    utilityType: input.utilityType,
    purpose: input.purpose ?? 'BUILDING',
    uomId: input.uomId,
    serialNumber: input.serialNumber ?? null,
    status: input.status ?? 'ACTIVE',
  };

  try {
    const record = await utilityMeterRepository.createMeter(newMeter);
    return toPublicUtilityMeter(record, uom);
  } catch (error) {
    if (isCodeUniqueViolation(error)) {
      throw utilityMeterCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getUtilityMeterById(
  id: string,
  actorUserId?: string,
): Promise<PublicUtilityMeter> {
  const record = await utilityMeterRepository.findById(id);
  if (!record) {
    throw utilityMeterNotFoundError();
  }
  await assertBuildingAccess(actorUserId, record.buildingId);

  const uoms = await loadUomContexts([record.uomId]);
  return toPublicUtilityMeter(record, uoms.get(record.uomId) ?? null);
}

export async function listUtilityMetersByBuilding(
  buildingId: string,
  filters: UtilityMeterFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeter[]> {
  await resolveBuildingContext(buildingId);
  await assertBuildingAccess(actorUserId, buildingId);

  const records = await utilityMeterRepository.listByBuilding(buildingId, filters);
  const uoms = await loadUomContexts(records.map((record) => record.uomId));
  return records.map((record) =>
    toPublicUtilityMeter(record, uoms.get(record.uomId) ?? null),
  );
}

/**
 * Client-scoped listing. When `buildingId` is supplied it must belong to the
 * Client and be accessible; otherwise results are restricted to the actor's
 * accessible Buildings at the database level (never filtered post-fetch).
 */
export async function listUtilityMetersByClient(
  clientId: string,
  filters: UtilityMeterFilters & { buildingId?: string },
  actorUserId?: string,
): Promise<PublicUtilityMeter[]> {
  if (filters.buildingId) {
    const context = await resolveBuildingContext(filters.buildingId);
    if (context.clientId !== clientId) {
      throw utilityMeterLocationMismatchError(
        'The referenced building does not belong to this client.',
      );
    }
    await assertBuildingAccess(actorUserId, filters.buildingId);
  } else {
    await assertClientAccess(actorUserId, clientId);
  }

  const records = await utilityMeterRepository.listByClient(clientId, filters);

  const scoped = actorUserId
    ? await restrictToAccessibleBuildings(records, actorUserId)
    : records;

  const uoms = await loadUomContexts(scoped.map((record) => record.uomId));
  return scoped.map((record) =>
    toPublicUtilityMeter(record, uoms.get(record.uomId) ?? null),
  );
}

async function restrictToAccessibleBuildings(
  records: readonly UtilityMeterRecord[],
  actorUserId: string,
): Promise<UtilityMeterRecord[]> {
  if (records.length === 0) {
    return [];
  }
  const accessible = new Set(
    await contextAccessService.getAccessibleBuildingIds(actorUserId),
  );
  return records.filter((record) => accessible.has(record.buildingId));
}

/**
 * Updates a Meter. The Building (and therefore the Client) of an existing
 * Meter is immutable in BE-18A — relocation is not part of this PART.
 */
export async function updateUtilityMeter(
  id: string,
  input: UpdateUtilityMeterInput,
  actorUserId?: string,
): Promise<PublicUtilityMeter> {
  const existing = await utilityMeterRepository.findById(id);
  if (!existing) {
    throw utilityMeterNotFoundError();
  }
  await assertBuildingAccess(actorUserId, existing.buildingId);

  if (input.uomId !== undefined) {
    await assertUom(input.uomId, existing.clientId);
  }

  // BE-18B — re-validate the combination whenever either side changes.
  if (input.uomId !== undefined || input.utilityType !== undefined) {
    await assertMeterUtilityConfiguration(
      existing.clientId,
      input.utilityType ?? existing.utilityType,
      input.uomId ?? existing.uomId,
    );
  }

  const nextSpaceId =
    input.spaceId === undefined ? existing.spaceId : input.spaceId;
  const nextFunctionalLocationId =
    input.functionalLocationId === undefined
      ? existing.functionalLocationId
      : input.functionalLocationId;

  if (input.spaceId !== undefined || input.functionalLocationId !== undefined) {
    await assertLocationReferences(existing.buildingId, {
      spaceId: nextSpaceId,
      functionalLocationId: nextFunctionalLocationId,
    });
  }

  const updated = await utilityMeterRepository.updateMeter(id, input);
  if (!updated) {
    throw utilityMeterNotFoundError();
  }

  const uoms = await loadUomContexts([updated.uomId]);
  return toPublicUtilityMeter(updated, uoms.get(updated.uomId) ?? null);
}

export async function updateUtilityMeterStatus(
  id: string,
  input: UpdateUtilityMeterStatusInput,
  actorUserId?: string,
): Promise<PublicUtilityMeter> {
  return updateUtilityMeter(id, { status: input.status }, actorUserId);
}

function isCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'utility_meters_client_code_unique'
  );
}

export const utilityMeterService = {
  createUtilityMeter,
  getUtilityMeterById,
  listUtilityMetersByBuilding,
  listUtilityMetersByClient,
  toPublicUtilityMeter,
  updateUtilityMeter,
  updateUtilityMeterStatus,
};
