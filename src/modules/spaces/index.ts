export {
  spaceCodeAlreadyExistsError,
  spaceNotFoundError,
  spaceRoomInactiveError,
} from './space.errors';

export { spaceRepository } from './space.repository';

export {
  createSpace,
  getSpaceById,
  listSpacesByRoom,
  resolveRoomBuildingId,
  spaceService,
  toPublicSpace,
  updateSpace,
  updateSpaceStatus,
} from './space.service';

export { SPACE_STATUSES, isSpaceStatus } from './space.types';

export {
  isValidSpaceCode,
  normalizeSpaceCode,
  parseCreateSpaceBody,
  parseSpaceIdParam,
  parseSpaceRoomIdParam,
  parseUpdateSpaceBody,
  parseUpdateSpaceStatusBody,
} from './space.validation';

export type {
  CreateSpaceInput,
  NewSpace,
  PublicSpace,
  SpaceRecord,
  SpaceStatus,
  UpdateSpaceInput,
  UpdateSpaceStatusInput,
} from './space.types';

export type { ValidationDetail } from './space.validation';
