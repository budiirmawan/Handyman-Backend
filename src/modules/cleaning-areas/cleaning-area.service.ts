import { areaNotFoundError, areaRepository } from '../areas';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { floorNotFoundError, floorRepository } from '../floors';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { propertyNotFoundError, propertyRepository } from '../properties';
import { roomNotFoundError, roomRepository } from '../rooms';
import { spaceNotFoundError, spaceRepository } from '../spaces';
import {
  cleaningAreaBuildingInactiveError,
  cleaningAreaCodeAlreadyExistsError,
  cleaningAreaLocationMismatchError,
  cleaningAreaNotFoundError,
} from './cleaning-area.errors';
import { cleaningAreaRepository } from './cleaning-area.repository';
import type {
  CleaningAreaFilter,
  CleaningAreaRecord,
  CleaningAreaStatus,
  CreateCleaningAreaInput,
  PublicCleaningArea,
  UpdateCleaningAreaInput,
} from './cleaning-area.types';

export function toPublicCleaningArea(
  record: CleaningAreaRecord,
): PublicCleaningArea {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    spaceId: record.spaceId,
    functionalLocationId: record.functionalLocationId,
    code: record.code,
    name: record.name,
    description: record.description,
    cleaningAreaType: record.cleaningAreaType,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Validates that all referenced physical location entities exist and resolve
 * to the specified Building through the authoritative digital structure hierarchy.
 */
async function assertLocationReferences(
  buildingId: string,
  locations: {
    floorId?: string | null;
    areaId?: string | null;
    roomId?: string | null;
    spaceId?: string | null;
    functionalLocationId?: string | null;
  },
): Promise<void> {
  if (locations.floorId) {
    const floor = await floorRepository.findById(locations.floorId);
    if (!floor) {
      throw floorNotFoundError();
    }
    if (floor.buildingId !== buildingId) {
      throw cleaningAreaLocationMismatchError(
        'The referenced floor does not belong to this building.',
      );
    }
  }

  if (locations.areaId) {
    const area = await areaRepository.findById(locations.areaId);
    if (!area) {
      throw areaNotFoundError();
    }
    const floor = await floorRepository.findById(area.floorId);
    if (!floor || floor.buildingId !== buildingId) {
      throw cleaningAreaLocationMismatchError(
        'The referenced area does not belong to this building.',
      );
    }
    if (locations.floorId && area.floorId !== locations.floorId) {
      throw cleaningAreaLocationMismatchError(
        'The referenced area does not belong to the referenced floor.',
      );
    }
  }

  if (locations.roomId) {
    const room = await roomRepository.findById(locations.roomId);
    if (!room) {
      throw roomNotFoundError();
    }
    const area = await areaRepository.findById(room.areaId);
    const floor = area ? await floorRepository.findById(area.floorId) : null;
    if (!floor || floor.buildingId !== buildingId) {
      throw cleaningAreaLocationMismatchError(
        'The referenced room does not belong to this building.',
      );
    }
    if (locations.areaId && room.areaId !== locations.areaId) {
      throw cleaningAreaLocationMismatchError(
        'The referenced room does not belong to the referenced area.',
      );
    }
  }

  if (locations.spaceId) {
    const space = await spaceRepository.findById(locations.spaceId);
    if (!space) {
      throw spaceNotFoundError();
    }
    const room = await roomRepository.findById(space.roomId);
    const area = room ? await areaRepository.findById(room.areaId) : null;
    const floor = area ? await floorRepository.findById(area.floorId) : null;
    if (!floor || floor.buildingId !== buildingId) {
      throw cleaningAreaLocationMismatchError(
        'The referenced space does not belong to this building.',
      );
    }
    if (locations.roomId && space.roomId !== locations.roomId) {
      throw cleaningAreaLocationMismatchError(
        'The referenced space does not belong to the referenced room.',
      );
    }
  }

  if (locations.functionalLocationId) {
    const fl = await functionalLocationRepository.findById(
      locations.functionalLocationId,
    );
    if (!fl) {
      throw functionalLocationNotFoundError();
    }
    if (fl.buildingId !== buildingId) {
      throw cleaningAreaLocationMismatchError(
        'The referenced functional location does not belong to this building.',
      );
    }
  }
}

/**
 * Creates a Housekeeping Cleaning Area operational scope under a Building.
 */
export async function createCleaningArea(
  input: CreateCleaningAreaInput,
): Promise<PublicCleaningArea> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  if (building.status !== 'ACTIVE') {
    throw cleaningAreaBuildingInactiveError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  const clientId = property.clientId;

  await assertLocationReferences(input.buildingId, input);

  const existing = await cleaningAreaRepository.findByCodeForBuilding(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw cleaningAreaCodeAlreadyExistsError();
  }

  try {
    const record = await cleaningAreaRepository.create({
      ...input,
      clientId,
    });
    return toPublicCleaningArea(record);
  } catch (error) {
    if (isCleaningAreaCodeUniqueViolation(error)) {
      throw cleaningAreaCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getCleaningAreaById(
  id: string,
): Promise<PublicCleaningArea> {
  const record = await cleaningAreaRepository.findById(id);
  if (!record) {
    throw cleaningAreaNotFoundError();
  }
  return toPublicCleaningArea(record);
}

export async function listCleaningAreasByBuilding(
  buildingId: string,
  filter: CleaningAreaFilter = {},
): Promise<PublicCleaningArea[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  if (
    filter.floorId ||
    filter.areaId ||
    filter.roomId ||
    filter.spaceId ||
    filter.functionalLocationId
  ) {
    await assertLocationReferences(buildingId, filter);
  }

  const records = await cleaningAreaRepository.listByBuilding(
    buildingId,
    filter,
  );
  return records.map(toPublicCleaningArea);
}

export async function updateCleaningArea(
  id: string,
  input: UpdateCleaningAreaInput,
): Promise<PublicCleaningArea> {
  const existing = await cleaningAreaRepository.findById(id);
  if (!existing) {
    throw cleaningAreaNotFoundError();
  }

  if (
    input.floorId !== undefined ||
    input.areaId !== undefined ||
    input.roomId !== undefined ||
    input.spaceId !== undefined ||
    input.functionalLocationId !== undefined
  ) {
    await assertLocationReferences(existing.buildingId, {
      floorId: input.floorId === undefined ? existing.floorId : input.floorId,
      areaId: input.areaId === undefined ? existing.areaId : input.areaId,
      roomId: input.roomId === undefined ? existing.roomId : input.roomId,
      spaceId: input.spaceId === undefined ? existing.spaceId : input.spaceId,
      functionalLocationId:
        input.functionalLocationId === undefined
          ? existing.functionalLocationId
          : input.functionalLocationId,
    });
  }

  const record = await cleaningAreaRepository.update(id, input);
  return toPublicCleaningArea(record as CleaningAreaRecord);
}

export async function updateCleaningAreaStatus(
  id: string,
  status: CleaningAreaStatus,
): Promise<PublicCleaningArea> {
  const existing = await cleaningAreaRepository.findById(id);
  if (!existing) {
    throw cleaningAreaNotFoundError();
  }

  const record = await cleaningAreaRepository.updateStatus(id, status);
  return toPublicCleaningArea(record as CleaningAreaRecord);
}

function isCleaningAreaCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'cleaning_areas_building_code_unique'
  );
}

export const cleaningAreaService = {
  createCleaningArea,
  getCleaningAreaById,
  listCleaningAreasByBuilding,
  toPublicCleaningArea,
  updateCleaningArea,
  updateCleaningAreaStatus,
};
