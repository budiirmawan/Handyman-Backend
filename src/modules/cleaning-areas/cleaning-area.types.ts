/**
 * BE-11A — Cleaning Area domain types.
 *
 * Cleaning Area represents a Housekeeping operational cleaning scope
 * anchored to the building digital structure (Floor, Area, Room, Space,
 * Functional Location).
 */

export const CLEANING_AREA_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type CleaningAreaStatus = (typeof CLEANING_AREA_STATUSES)[number];

export const CLEANING_AREA_TYPES = [
  'GENERAL',
  'ROOM',
  'TOILET',
  'PUBLIC_AREA',
  'OFFICE',
  'CORRIDOR',
  'OUTDOOR',
  'OTHER',
] as const;
export type CleaningAreaType = (typeof CLEANING_AREA_TYPES)[number];

export function isCleaningAreaStatus(
  value: unknown,
): value is CleaningAreaStatus {
  return (
    typeof value === 'string' &&
    (CLEANING_AREA_STATUSES as readonly string[]).includes(value)
  );
}

export function isCleaningAreaType(value: unknown): value is CleaningAreaType {
  return (
    typeof value === 'string' &&
    (CLEANING_AREA_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type CleaningAreaRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  functionalLocationId: string | null;
  code: string;
  name: string;
  description: string | null;
  cleaningAreaType: CleaningAreaType;
  status: CleaningAreaStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicCleaningArea = {
  id: string;
  clientId: string;
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  functionalLocationId: string | null;
  code: string;
  name: string;
  description: string | null;
  cleaningAreaType: CleaningAreaType;
  status: CleaningAreaStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateCleaningAreaInput = {
  buildingId: string;
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  code: string;
  name: string;
  description?: string | null;
  cleaningAreaType?: CleaningAreaType;
  status?: CleaningAreaStatus;
};

export type UpdateCleaningAreaInput = {
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  name?: string;
  description?: string | null;
  cleaningAreaType?: CleaningAreaType;
  status?: CleaningAreaStatus;
};

export type CleaningAreaFilter = {
  status?: CleaningAreaStatus;
  cleaningAreaType?: CleaningAreaType;
  floorId?: string;
  areaId?: string;
  roomId?: string;
  spaceId?: string;
  functionalLocationId?: string;
};
