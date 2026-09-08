export {
  roomTypeClientMismatchError,
  roomTypeCodeAlreadyExistsError,
  roomTypeInactiveError,
  roomTypeNotFoundError,
} from './room-type.errors';

export { roomTypeRepository } from './room-type.repository';

export {
  createRoomType,
  getRoomTypeById,
  listRoomTypesByClient,
  roomTypeService,
  toPublicRoomType,
  updateRoomType,
  updateRoomTypeStatus,
} from './room-type.service';

export { ROOM_TYPE_STATUSES, isRoomTypeStatus } from './room-type.types';

export {
  isValidRoomTypeCode,
  normalizeRoomTypeCode,
  parseCreateRoomTypeBody,
  parseRoomTypeClientIdParam,
  parseRoomTypeIdParam,
  parseUpdateRoomTypeBody,
  parseUpdateRoomTypeStatusBody,
} from './room-type.validation';

export type {
  CreateRoomTypeInput,
  NewRoomType,
  PublicRoomType,
  RoomTypeRecord,
  RoomTypeStatus,
  UpdateRoomTypeInput,
  UpdateRoomTypeStatusInput,
} from './room-type.types';

export type { ValidationDetail } from './room-type.validation';
