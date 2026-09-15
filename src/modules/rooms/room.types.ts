/**
 * BE-04D — Room domain types.
 *
 * A Room is a bounded operational unit inside exactly one Area/Zone
 * (Building → Floor → Area/Zone → Room). Client ownership is derived
 * authoritatively through Room → Area → Floor → Building → Property →
 * Client.
 *
 * A Room is NOT a Room Type, Space, Functional Location, Asset, or Equipment
 * — those belong to later BE-04 PARTs (or are out of BE-04 scope entirely).
 * Room Type classification arrives in BE-04E as reference data.
 */
export const ROOM_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];

export function isRoomStatus(value: unknown): value is RoomStatus {
  return (
    typeof value === 'string' &&
    (ROOM_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type RoomRecord = {
  id: string;
  areaId: string;
  /** Optional classification (BE-04E). NULL = unclassified Room. */
  roomTypeId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: RoomStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicRoom = {
  id: string;
  areaId: string;
  roomTypeId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: RoomStatus;
};

/** Input supplied by the API consumer when creating a Room. */
export type CreateRoomInput = {
  areaId: string;
  code: string;
  name: string;
  description?: string;
  status?: RoomStatus;
};

/** Fully-resolved room data ready for persistence. */
export type NewRoom = {
  areaId: string;
  code: string;
  name: string;
  description: string | null;
  status: RoomStatus;
};

/** Partial update input (PATCH /rooms/:id). */
export type UpdateRoomInput = {
  name?: string;
  description?: string;
  status?: RoomStatus;
  /** A Room Type id assigns the classification; null clears it. */
  roomTypeId?: string | null;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateRoomStatusInput = {
  status: RoomStatus;
};
