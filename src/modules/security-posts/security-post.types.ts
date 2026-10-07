/**
 * BE-12A — Security Post domain types.
 *
 * A Security Post represents an operational Security duty/post location
 * anchored to the existing building digital structure (Building → Floor /
 * Area / Room / Space / Functional Location). It is NOT a duplicate
 * location hierarchy; the post is a minimal operational master/context
 * record that names a Security duty/location and references authoritative
 * BE-04 structure rows.
 *
 * Client ownership is derived authoritatively through Security Post →
 * Building → Property → Client. A Security Post is operational context
 * only; it is not an asset, work order, finding, task, schedule, route,
 * or patrol execution.
 */
export const SECURITY_POST_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type SecurityPostStatus = (typeof SECURITY_POST_STATUSES)[number];

export const SECURITY_POST_TYPES = [
  'GENERAL',
  'LOBBY',
  'GATE',
  'PERIMETER',
  'PARKING',
  'CONTROL_ROOM',
  'PATROL',
  'STANDBY',
  'OTHER',
] as const;
export type SecurityPostType = (typeof SECURITY_POST_TYPES)[number];

export function isSecurityPostStatus(value: unknown): value is SecurityPostStatus {
  return (
    typeof value === 'string' &&
    (SECURITY_POST_STATUSES as readonly string[]).includes(value)
  );
}

export function isSecurityPostType(value: unknown): value is SecurityPostType {
  return (
    typeof value === 'string' &&
    (SECURITY_POST_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type SecurityPostRecord = {
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
  postType: SecurityPostType;
  status: SecurityPostStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicSecurityPost = {
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
  postType: SecurityPostType;
  status: SecurityPostStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreateSecurityPostInput = {
  buildingId: string;
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  code: string;
  name: string;
  description?: string | null;
  postType?: SecurityPostType;
  status?: SecurityPostStatus;
};

export type UpdateSecurityPostInput = {
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  name?: string;
  description?: string | null;
  postType?: SecurityPostType;
  status?: SecurityPostStatus;
};

export type SecurityPostFilter = {
  status?: SecurityPostStatus;
  postType?: SecurityPostType;
  floorId?: string;
  areaId?: string;
  roomId?: string;
  spaceId?: string;
  functionalLocationId?: string;
};
