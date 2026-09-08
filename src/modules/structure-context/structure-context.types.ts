/**
 * BE-04H — Hierarchy & Operational Context types.
 *
 * These are READ-ONLY projections over the authoritative BE-04 tables:
 *
 *   Property → Building → [Campus?] → Floor → Area/Zone → Room → Space
 *                                                              → Functional Location
 *
 * Room Type remains classification only (attached to Room, never a level).
 * Functional Location remains operational location context only. Nothing
 * here creates, duplicates, or shadows source-of-truth rows — and nothing
 * here is an Asset, Equipment, Work Order, Checklist, or Task.
 */
import type { AreaType } from '../areas';
import type { FunctionalLocationStatus } from '../functional-locations';

/** Minimal authoritative summary of one structure node. */
export type StructureNode = {
  id: string;
  code: string;
  name: string;
  status: string;
};

export type FloorNode = StructureNode & { levelNumber: number };

export type AreaNode = StructureNode & { type: AreaType };

/** Room summary; `roomType` is the optional classification (never a level). */
export type RoomNode = StructureNode & { roomType: StructureNode | null };

export type FunctionalLocationNode = StructureNode & {
  spaceId: string | null;
  status: FunctionalLocationStatus;
};

/**
 * Reusable operational location context for one requested node. Only the
 * levels that actually exist for that node are present — missing hierarchy
 * levels are never invented. `campus` appears only when the Building is
 * grouped under one.
 */
export type OperationalContext = {
  client: StructureNode;
  property: StructureNode;
  campus?: StructureNode;
  building: StructureNode;
  floor?: FloorNode;
  area?: AreaNode;
  room?: StructureNode;
  roomType?: StructureNode;
  space?: StructureNode;
  functionalLocation?: FunctionalLocationNode;
};

/** Space subtree: spaces carry their pinned Functional Locations. */
export type SpaceHierarchy = StructureNode & {
  functionalLocations: FunctionalLocationNode[];
};

export type RoomHierarchy = RoomNode & { spaces: SpaceHierarchy[] };

export type AreaHierarchy = AreaNode & { rooms: RoomHierarchy[] };

export type FloorHierarchy = FloorNode & { areas: AreaHierarchy[] };

/**
 * The full authoritative digital structure of one Building. Building-level
 * Functional Locations (no Space pin) sit in `functionalLocations`;
 * Space-pinned ones appear under their Space.
 */
export type BuildingHierarchy = {
  client: StructureNode;
  property: StructureNode;
  campus?: StructureNode;
  building: StructureNode;
  floors: FloorHierarchy[];
  functionalLocations: FunctionalLocationNode[];
};

/** Result of a consistency validation pass over one Building's structure. */
export type HierarchyValidationResult = {
  consistent: boolean;
  violations: string[];
};
