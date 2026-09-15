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
  securityPostBuildingInactiveError,
  securityPostCodeAlreadyExistsError,
  securityPostLocationMismatchError,
  securityPostNotFoundError,
} from './security-post.errors';
import { securityPostRepository } from './security-post.repository';
import type {
  CreateSecurityPostInput,
  PublicSecurityPost,
  SecurityPostFilter,
  SecurityPostRecord,
  SecurityPostStatus,
  UpdateSecurityPostInput,
} from './security-post.types';

export function toPublicSecurityPost(
  record: SecurityPostRecord,
): PublicSecurityPost {
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
    postType: record.postType,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Validates that all referenced physical location entities exist and resolve
 * to the specified Building through the authoritative digital structure
 * hierarchy. Mirrors the BE-11A cleaning-area location reference check so a
 * Security Post can never reference a Floor / Area / Room / Space /
 * Functional Location that lives under another Building (cross-Building
 * location is rejected) or another Client (implicit — Client is derived
 * through Building → Property → Client).
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
      throw securityPostLocationMismatchError(
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
      throw securityPostLocationMismatchError(
        'The referenced area does not belong to this building.',
      );
    }
    if (locations.floorId && area.floorId !== locations.floorId) {
      throw securityPostLocationMismatchError(
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
      throw securityPostLocationMismatchError(
        'The referenced room does not belong to this building.',
      );
    }
    if (locations.areaId && room.areaId !== locations.areaId) {
      throw securityPostLocationMismatchError(
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
      throw securityPostLocationMismatchError(
        'The referenced space does not belong to this building.',
      );
    }
    if (locations.roomId && space.roomId !== locations.roomId) {
      throw securityPostLocationMismatchError(
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
      throw securityPostLocationMismatchError(
        'The referenced functional location does not belong to this building.',
      );
    }
  }
}

/**
 * Creates a Security Post under a Building.
 */
export async function createSecurityPost(
  input: CreateSecurityPostInput,
): Promise<PublicSecurityPost> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  if (building.status !== 'ACTIVE') {
    throw securityPostBuildingInactiveError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  const clientId = property.clientId;

  await assertLocationReferences(input.buildingId, input);

  const existing = await securityPostRepository.findByCodeForBuilding(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw securityPostCodeAlreadyExistsError();
  }

  try {
    const record = await securityPostRepository.create({
      ...input,
      clientId,
    });
    return toPublicSecurityPost(record);
  } catch (error) {
    if (isSecurityPostCodeUniqueViolation(error)) {
      throw securityPostCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getSecurityPostById(
  id: string,
): Promise<PublicSecurityPost> {
  const record = await securityPostRepository.findById(id);
  if (!record) {
    throw securityPostNotFoundError();
  }
  return toPublicSecurityPost(record);
}

export async function listSecurityPostsByBuilding(
  buildingId: string,
  filter: SecurityPostFilter = {},
): Promise<PublicSecurityPost[]> {
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

  const records = await securityPostRepository.listByBuilding(
    buildingId,
    filter,
  );
  return records.map(toPublicSecurityPost);
}

export async function updateSecurityPost(
  id: string,
  input: UpdateSecurityPostInput,
): Promise<PublicSecurityPost> {
  const existing = await securityPostRepository.findById(id);
  if (!existing) {
    throw securityPostNotFoundError();
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

  const record = await securityPostRepository.update(id, input);
  return toPublicSecurityPost(record as SecurityPostRecord);
}

export async function updateSecurityPostStatus(
  id: string,
  status: SecurityPostStatus,
): Promise<PublicSecurityPost> {
  const existing = await securityPostRepository.findById(id);
  if (!existing) {
    throw securityPostNotFoundError();
  }

  const record = await securityPostRepository.updateStatus(id, status);
  return toPublicSecurityPost(record as SecurityPostRecord);
}

function isSecurityPostCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'security_posts_building_code_unique'
  );
}

export const securityPostService = {
  createSecurityPost,
  getSecurityPostById,
  listSecurityPostsByBuilding,
  toPublicSecurityPost,
  updateSecurityPost,
  updateSecurityPostStatus,
};
