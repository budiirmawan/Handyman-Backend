/**
 * BE-04C — Area / Zone domain types.
 *
 * An Area (or Zone) is an operational grouping inside exactly one Floor
 * (Building → Floor → Area/Zone). Client ownership is derived
 * authoritatively through Area → Floor → Building → Property → Client.
 *
 * `type` is a lightweight classification only — `AREA` (a physical section,
 * e.g. LOBBY, WING_A) or `ZONE` (an operational grouping, e.g. a cleaning or
 * patrol zone). It is deliberately NOT a generic spatial taxonomy.
 *
 * An Area is NOT a Room, Room Type, Space, Functional Location, Asset, or
 * Equipment — those belong to later BE-04 PARTs (or are out of BE-04 scope).
 */
export const AREA_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type AreaStatus = (typeof AREA_STATUSES)[number];

export function isAreaStatus(value: unknown): value is AreaStatus {
  return (
    typeof value === 'string' &&
    (AREA_STATUSES as readonly string[]).includes(value)
  );
}

export const AREA_TYPES = ['AREA', 'ZONE'] as const;

export type AreaType = (typeof AREA_TYPES)[number];

export function isAreaType(value: unknown): value is AreaType {
  return (
    typeof value === 'string' &&
    (AREA_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type AreaRecord = {
  id: string;
  floorId: string;
  code: string;
  name: string;
  type: AreaType;
  description: string | null;
  status: AreaStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicArea = {
  id: string;
  floorId: string;
  code: string;
  name: string;
  type: AreaType;
  description: string | null;
  status: AreaStatus;
};

/** Input supplied by the API consumer when creating an Area. */
export type CreateAreaInput = {
  floorId: string;
  code: string;
  name: string;
  type?: AreaType;
  description?: string;
  status?: AreaStatus;
};

/** Fully-resolved area data ready for persistence. */
export type NewArea = {
  floorId: string;
  code: string;
  name: string;
  type: AreaType;
  description: string | null;
  status: AreaStatus;
};

/** Partial update input (PATCH /areas/:id). */
export type UpdateAreaInput = {
  name?: string;
  type?: AreaType;
  description?: string;
  status?: AreaStatus;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateAreaStatusInput = {
  status: AreaStatus;
};
