import { floorRepository } from '../floors';
import { spaceService } from '../spaces';
import { resolveApartmentBuildingScope } from './apartment-master.scope';
import {
  apartmentUnitFloorMismatchError,
  apartmentUnitNotFoundError,
} from './unit-party-role.errors';
import { apartmentUnitRepository } from './unit.repository';
import type {
  ApartmentUnitFilters,
  ApartmentUnitOccupancyFilters,
  ApartmentUnitOccupancyRecord,
  ApartmentUnitRecord,
} from './unit.types';
import type { PaginationParams } from '../../shared/pagination';

/**
 * CR-HM-MASTER-IND-01 — Unit administration reads/writes.
 *
 * A Unit is the existing Space master. This service adds the
 * Building/Floor-scoped administration view (Tower/Building → Floor → Unit)
 * without creating a second physical master: writes delegate to the existing
 * Space service, reads are keyed by the Server-derived
 * (clientId, buildingId) pair.
 */

function assertUnitInScope(
  unit: ApartmentUnitRecord | null,
  clientId: string,
): ApartmentUnitRecord {
  if (!unit || unit.clientId !== clientId) {
    throw apartmentUnitNotFoundError();
  }
  return unit;
}

async function assertFloorInBuilding(
  floorId: string,
  buildingId: string,
): Promise<void> {
  const floor = await floorRepository.findById(floorId);
  if (!floor || floor.buildingId !== buildingId) {
    throw apartmentUnitFloorMismatchError();
  }
}

export async function listApartmentUnits(input: {
  actorUserId: string;
  buildingId: string;
  filters: ApartmentUnitFilters;
  page: PaginationParams;
}): Promise<{ items: ApartmentUnitRecord[]; total: number }> {
  const scope = await resolveApartmentBuildingScope({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
  });
  if (input.filters.floorId !== undefined) {
    await assertFloorInBuilding(input.filters.floorId, scope.buildingId);
  }
  return apartmentUnitRepository.listUnits({
    clientId: scope.clientId,
    buildingId: scope.buildingId,
    filters: input.filters,
    page: { limit: input.page.limit, offset: input.page.offset },
  });
}

export async function getApartmentUnit(input: {
  actorUserId: string;
  buildingId: string;
  unitId: string;
}): Promise<ApartmentUnitRecord> {
  const scope = await resolveApartmentBuildingScope({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
  });
  return assertUnitInScope(
    await apartmentUnitRepository.findUnit({
      clientId: scope.clientId,
      buildingId: scope.buildingId,
      unitId: input.unitId,
    }),
    scope.clientId,
  );
}

/**
 * Unit master write within the Building scope. Only name/description/status
 * are reachable — Unit identity (code, room, floor, Building) stays immutable
 * through the existing Space contract.
 */
export async function updateApartmentUnit(input: {
  actorUserId: string;
  buildingId: string;
  unitId: string;
  name?: string;
  description?: string;
  status?: 'ACTIVE' | 'INACTIVE';
}): Promise<ApartmentUnitRecord> {
  const scope = await resolveApartmentBuildingScope({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
  });
  const unit = assertUnitInScope(
    await apartmentUnitRepository.findUnit({
      clientId: scope.clientId,
      buildingId: scope.buildingId,
      unitId: input.unitId,
    }),
    scope.clientId,
  );

  await spaceService.updateSpace(unit.id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.status === undefined ? {} : { status: input.status }),
  });

  const updated = await apartmentUnitRepository.findUnit({
    clientId: scope.clientId,
    buildingId: scope.buildingId,
    unitId: unit.id,
  });
  if (!updated) throw apartmentUnitNotFoundError();
  return updated;
}

/**
 * Effective-dated occupancy history for one Unit. TENANCY authority remains
 * `tenant_space_relationships`; this read exposes its history (ACTIVE and
 * INACTIVE rows) with the party master joined, so a Tenant change never
 * erases who occupied the Unit before.
 */
export async function listApartmentUnitOccupancies(input: {
  actorUserId: string;
  buildingId: string;
  unitId: string;
  filters: ApartmentUnitOccupancyFilters;
  page: PaginationParams;
}): Promise<{ items: ApartmentUnitOccupancyRecord[]; total: number }> {
  const scope = await resolveApartmentBuildingScope({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
  });
  assertUnitInScope(
    await apartmentUnitRepository.findUnit({
      clientId: scope.clientId,
      buildingId: scope.buildingId,
      unitId: input.unitId,
    }),
    scope.clientId,
  );
  return apartmentUnitRepository.listUnitOccupancies({
    clientId: scope.clientId,
    buildingId: scope.buildingId,
    unitId: input.unitId,
    filters: input.filters,
    page: { limit: input.page.limit, offset: input.page.offset },
  });
}

export const apartmentUnitService = {
  getApartmentUnit,
  listApartmentUnitOccupancies,
  listApartmentUnits,
  updateApartmentUnit,
};
