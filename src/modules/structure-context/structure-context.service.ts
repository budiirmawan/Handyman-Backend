import { areaNotFoundError, areaRepository, type AreaRecord } from '../areas';
import {
  buildingNotFoundError,
  buildingRepository,
  type BuildingRecord,
} from '../buildings';
import { campusRepository, type CampusRecord } from '../campuses';
import { clientNotFoundError, clientRepository } from '../clients';
import { floorNotFoundError, floorRepository, type FloorRecord } from '../floors';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
  type FunctionalLocationRecord,
} from '../functional-locations';
import { propertyNotFoundError, propertyRepository } from '../properties';
import { roomNotFoundError, roomRepository, type RoomRecord } from '../rooms';
import { roomTypeRepository } from '../room-types';
import { spaceNotFoundError, spaceRepository, type SpaceRecord } from '../spaces';
import { hierarchyInconsistentError } from './structure-context.errors';
import type {
  AreaNode,
  BuildingHierarchy,
  FloorNode,
  FunctionalLocationNode,
  HierarchyValidationResult,
  OperationalContext,
  RoomNode,
  StructureNode,
} from './structure-context.types';

/**
 * BE-04H — the authoritative Building Digital Structure resolver.
 *
 * Every function here READS the existing BE-04 repositories and projects
 * them into hierarchy/context results. No new source-of-truth tables, no
 * writes, no Assets, no Equipment. BE-02 isolation is enforced at the API
 * layer (routes/controllers), exactly like every other BE-04 surface.
 */

function toNode(record: {
  id: string;
  code: string;
  name: string;
  status: string;
}): StructureNode {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    status: record.status,
  };
}

function toFloorNode(record: FloorRecord): FloorNode {
  return { ...toNode(record), levelNumber: record.levelNumber };
}

function toAreaNode(record: AreaRecord): AreaNode {
  return { ...toNode(record), type: record.type };
}

function toFunctionalLocationNode(
  record: FunctionalLocationRecord,
): FunctionalLocationNode {
  return { ...toNode(record), spaceId: record.spaceId, status: record.status };
}

async function toRoomNode(record: RoomRecord): Promise<RoomNode> {
  let roomType: StructureNode | null = null;
  if (record.roomTypeId) {
    const roomTypeRecord = await roomTypeRepository.findById(record.roomTypeId);
    // FK guarantees existence; a miss is a data-integrity fault.
    if (!roomTypeRecord) {
      throw hierarchyInconsistentError(
        `room ${record.id} references missing room type ${record.roomTypeId}`,
      );
    }
    roomType = toNode(roomTypeRecord);
  }
  return { ...toNode(record), roomType };
}

/**
 * Resolves the shared Building "roof" context: Client, Property, optional
 * Campus, Building. This is the single upward walk every resolver reuses,
 * and where cross-Property campus inconsistency would surface.
 */
async function resolveBuildingRoof(building: BuildingRecord): Promise<{
  client: StructureNode;
  property: StructureNode;
  campus?: StructureNode;
  building: StructureNode;
}> {
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  const client = await clientRepository.findById(property.clientId);
  if (!client) {
    throw clientNotFoundError();
  }

  let campus: CampusRecord | null = null;
  if (building.campusId) {
    campus = await campusRepository.findById(building.campusId);
    if (!campus) {
      throw hierarchyInconsistentError(
        `building ${building.id} references missing campus ${building.campusId}`,
      );
    }
    if (campus.propertyId !== building.propertyId) {
      throw hierarchyInconsistentError(
        `campus ${campus.id} belongs to a different property than building ${building.id}`,
      );
    }
  }

  return {
    client: toNode(client),
    property: toNode(property),
    ...(campus ? { campus: toNode(campus) } : {}),
    building: toNode(building),
  };
}

/**
 * Resolves the complete digital structure of one Building:
 * floors → areas → rooms (with Room Type classification) → spaces (with
 * their pinned Functional Locations), plus Building-level Functional
 * Locations. Levels that do not exist are simply absent — nothing is
 * invented.
 */
export async function resolveBuildingHierarchy(
  buildingId: string,
): Promise<BuildingHierarchy> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const roof = await resolveBuildingRoof(building);

  const allFunctionalLocations =
    await functionalLocationRepository.listByBuilding(buildingId);
  const bySpace = new Map<string, FunctionalLocationNode[]>();
  const buildingLevel: FunctionalLocationNode[] = [];
  for (const record of allFunctionalLocations) {
    const node = toFunctionalLocationNode(record);
    if (record.spaceId) {
      const list = bySpace.get(record.spaceId) ?? [];
      list.push(node);
      bySpace.set(record.spaceId, list);
    } else {
      buildingLevel.push(node);
    }
  }

  const floors = await floorRepository.listByBuilding(buildingId);
  const floorHierarchies = [];
  for (const floor of floors) {
    const areas = await areaRepository.listByFloor(floor.id);
    const areaHierarchies = [];
    for (const area of areas) {
      const rooms = await roomRepository.listByArea(area.id);
      const roomHierarchies = [];
      for (const room of rooms) {
        const spaces = await spaceRepository.listByRoom(room.id);
        const spaceHierarchies = spaces.map((space: SpaceRecord) => ({
          ...toNode(space),
          functionalLocations: bySpace.get(space.id) ?? [],
        }));
        roomHierarchies.push({
          ...(await toRoomNode(room)),
          spaces: spaceHierarchies,
        });
      }
      areaHierarchies.push({ ...toAreaNode(area), rooms: roomHierarchies });
    }
    floorHierarchies.push({ ...toFloorNode(floor), areas: areaHierarchies });
  }

  return {
    ...roof,
    floors: floorHierarchies,
    functionalLocations: buildingLevel,
  };
}

/** Operational context of a Building (roof levels only). */
export async function resolveBuildingContext(
  buildingId: string,
): Promise<OperationalContext> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  return resolveBuildingRoof(building);
}

/** Operational context of a Floor (roof + floor). */
export async function resolveFloorContext(
  floorId: string,
): Promise<OperationalContext> {
  const floor = await floorRepository.findById(floorId);
  if (!floor) {
    throw floorNotFoundError();
  }

  const context = await resolveBuildingContext(floor.buildingId);
  return { ...context, floor: toFloorNode(floor) };
}

/** Operational context of an Area/Zone (roof + floor + area). */
export async function resolveAreaContext(
  areaId: string,
): Promise<OperationalContext> {
  const area = await areaRepository.findById(areaId);
  if (!area) {
    throw areaNotFoundError();
  }

  const context = await resolveFloorContext(area.floorId);
  return { ...context, area: toAreaNode(area) };
}

/**
 * Operational context of a Room (roof + floor + area + room, plus the Room
 * Type classification when the Room carries one — classification only,
 * never a hierarchy level).
 */
export async function resolveRoomContext(
  roomId: string,
): Promise<OperationalContext> {
  const room = await roomRepository.findById(roomId);
  if (!room) {
    throw roomNotFoundError();
  }

  const context = await resolveAreaContext(room.areaId);
  const roomNode = await toRoomNode(room);
  return {
    ...context,
    room: toNode(room),
    ...(roomNode.roomType ? { roomType: roomNode.roomType } : {}),
  };
}

/** Operational context of a Space (roof + floor + area + room + space). */
export async function resolveSpaceContext(
  spaceId: string,
): Promise<OperationalContext> {
  const space = await spaceRepository.findById(spaceId);
  if (!space) {
    throw spaceNotFoundError();
  }

  const context = await resolveRoomContext(space.roomId);
  return { ...context, space: toNode(space) };
}

/**
 * Operational context of a Functional Location — the full location chain
 * behind the reference, and NOTHING else: location hierarchy only, never
 * Asset or Equipment domain records.
 *
 * A Building-level reference (no Space pin) resolves roof levels only. A
 * Space-pinned reference resolves the full physical chain, and the chain's
 * Building must equal the reference's own Building — a mismatch is a
 * data-integrity fault (500 HIERARCHY_INCONSISTENT), never silently served.
 */
export async function resolveFunctionalLocationContext(
  functionalLocationId: string,
): Promise<OperationalContext> {
  const record = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!record) {
    throw functionalLocationNotFoundError();
  }

  if (!record.spaceId) {
    const context = await resolveBuildingContext(record.buildingId);
    return { ...context, functionalLocation: toFunctionalLocationNode(record) };
  }

  const context = await resolveSpaceContext(record.spaceId);
  if (context.building.id !== record.buildingId) {
    throw hierarchyInconsistentError(
      `functional location ${record.id} is pinned to a space of a different building`,
    );
  }

  return { ...context, functionalLocation: toFunctionalLocationNode(record) };
}

/**
 * Validates the stored consistency rules across one Building's structure:
 *
 *   - Campus belongs to the Building's Property (where used)
 *   - Floors belong to the Building (by construction of the queries)
 *   - Areas → Floors, Rooms → Areas, Spaces → Rooms (FK-scoped queries)
 *   - Room Type classifications exist and belong to the Building's Client
 *   - Functional Locations pinned to Spaces resolve to this same Building
 *
 * Returns violations instead of throwing, so it can serve as a health/audit
 * capability. FKs make most violations impossible; the cross-parent rules
 * (campus property, room type client, functional location building) are the
 * ones that can genuinely drift and are checked explicitly.
 */
export async function validateBuildingHierarchy(
  buildingId: string,
): Promise<HierarchyValidationResult> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const violations: string[] = [];

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    violations.push(`building ${building.id} references missing property`);
  }

  if (building.campusId) {
    const campus = await campusRepository.findById(building.campusId);
    if (!campus) {
      violations.push(
        `building ${building.id} references missing campus ${building.campusId}`,
      );
    } else if (campus.propertyId !== building.propertyId) {
      violations.push(
        `campus ${campus.id} belongs to property ${campus.propertyId}, not ${building.propertyId}`,
      );
    }
  }

  const clientId = property?.clientId ?? null;

  const floors = await floorRepository.listByBuilding(buildingId);
  for (const floor of floors) {
    const areas = await areaRepository.listByFloor(floor.id);
    for (const area of areas) {
      const rooms = await roomRepository.listByArea(area.id);
      for (const room of rooms) {
        if (room.roomTypeId) {
          const roomType = await roomTypeRepository.findById(room.roomTypeId);
          if (!roomType) {
            violations.push(
              `room ${room.id} references missing room type ${room.roomTypeId}`,
            );
          } else if (clientId && roomType.clientId !== clientId) {
            violations.push(
              `room ${room.id} is classified by room type ${roomType.id} of another client`,
            );
          }
        }
      }
    }
  }

  const functionalLocations =
    await functionalLocationRepository.listByBuilding(buildingId);
  for (const record of functionalLocations) {
    if (!record.spaceId) {
      continue;
    }
    const space = await spaceRepository.findById(record.spaceId);
    if (!space) {
      violations.push(
        `functional location ${record.id} references missing space ${record.spaceId}`,
      );
      continue;
    }
    const room = await roomRepository.findById(space.roomId);
    const area = room ? await areaRepository.findById(room.areaId) : null;
    const floor = area ? await floorRepository.findById(area.floorId) : null;
    if (!floor || floor.buildingId !== buildingId) {
      violations.push(
        `functional location ${record.id} is pinned to a space outside building ${buildingId}`,
      );
    }
  }

  return { consistent: violations.length === 0, violations };
}

export const structureContextService = {
  resolveAreaContext,
  resolveBuildingContext,
  resolveBuildingHierarchy,
  resolveFloorContext,
  resolveFunctionalLocationContext,
  resolveRoomContext,
  resolveSpaceContext,
  validateBuildingHierarchy,
};
