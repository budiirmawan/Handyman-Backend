/**
 * BE-04A — Floor domain types.
 *
 * A Floor is a digital structure level inside exactly one Building
 * (Property → Building → Floor). Client ownership is derived authoritatively
 * through Floor → Building → Property → Client. A Floor is NOT a Campus,
 * Area, Room, Space, Functional Location, Asset, or Equipment — those belong
 * to later BE-04 PARTs (or are out of BE-04 scope entirely).
 *
 * `levelNumber` is the ordinal vertical position of the Floor within its
 * Building (0 = ground, negative = basement). It is ordering metadata only —
 * uniqueness is NOT enforced, because mezzanine/split levels can share one.
 */
export const FLOOR_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type FloorStatus = (typeof FLOOR_STATUSES)[number];

export function isFloorStatus(value: unknown): value is FloorStatus {
  return (
    typeof value === 'string' &&
    (FLOOR_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type FloorRecord = {
  id: string;
  buildingId: string;
  code: string;
  name: string;
  levelNumber: number;
  description: string | null;
  status: FloorStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicFloor = {
  id: string;
  buildingId: string;
  code: string;
  name: string;
  levelNumber: number;
  description: string | null;
  status: FloorStatus;
};

/** Input supplied by the API consumer when creating a Floor. */
export type CreateFloorInput = {
  buildingId: string;
  code: string;
  name: string;
  levelNumber: number;
  description?: string;
  status?: FloorStatus;
};

/** Fully-resolved floor data ready for persistence. */
export type NewFloor = {
  buildingId: string;
  code: string;
  name: string;
  levelNumber: number;
  description: string | null;
  status: FloorStatus;
};

/** Partial update input (PATCH /floors/:id). */
export type UpdateFloorInput = {
  name?: string;
  levelNumber?: number;
  description?: string;
  status?: FloorStatus;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateFloorStatusInput = {
  status: FloorStatus;
};
