export {
  roomAreaInactiveError,
  roomCodeAlreadyExistsError,
  roomNotFoundError,
} from './room.errors';

export { roomRepository } from './room.repository';

export {
  createRoom,
  getRoomById,
  listRoomsByArea,
  resolveAreaBuildingId,
  roomService,
  toPublicRoom,
  updateRoom,
  updateRoomStatus,
} from './room.service';

export { ROOM_STATUSES, isRoomStatus } from './room.types';

export {
  isValidRoomCode,
  normalizeRoomCode,
  parseCreateRoomBody,
  parseRoomAreaIdParam,
  parseRoomIdParam,
  parseUpdateRoomBody,
  parseUpdateRoomStatusBody,
} from './room.validation';

export type {
  CreateRoomInput,
  NewRoom,
  PublicRoom,
  RoomRecord,
  RoomStatus,
  UpdateRoomInput,
  UpdateRoomStatusInput,
} from './room.types';

export type { ValidationDetail } from './room.validation';
