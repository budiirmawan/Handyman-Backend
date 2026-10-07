/**
 * BE-04E — Room Type domain types.
 *
 * A Room Type is Client-scoped classification/reference data for Rooms
 * (e.g. OFFICE, MEETING_ROOM, TOILET, PANTRY). It is NOT a hierarchy level —
 * the structure chain remains Building → Floor → Area/Zone → Room, and a
 * Room Type merely classifies a Room via the optional `rooms.room_type_id`.
 *
 * Type codes are DATA, not behavior: no application logic branches on a
 * specific room type code.
 */
export const ROOM_TYPE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type RoomTypeStatus = (typeof ROOM_TYPE_STATUSES)[number];

export function isRoomTypeStatus(value: unknown): value is RoomTypeStatus {
  return (
    typeof value === 'string' &&
    (ROOM_TYPE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type RoomTypeRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: RoomTypeStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicRoomType = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: RoomTypeStatus;
};

/** Input supplied by the API consumer when creating a Room Type. */
export type CreateRoomTypeInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
  status?: RoomTypeStatus;
};

/** Fully-resolved room type data ready for persistence. */
export type NewRoomType = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: RoomTypeStatus;
};

/** Partial update input (PATCH /room-types/:id). */
export type UpdateRoomTypeInput = {
  name?: string;
  description?: string;
  status?: RoomTypeStatus;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateRoomTypeStatusInput = {
  status: RoomTypeStatus;
};
