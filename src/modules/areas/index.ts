export {
  areaCodeAlreadyExistsError,
  areaFloorInactiveError,
  areaNotFoundError,
} from './area.errors';

export { areaRepository } from './area.repository';

export {
  areaService,
  createArea,
  getAreaById,
  listAreasByFloor,
  resolveFloorBuildingId,
  toPublicArea,
  updateArea,
  updateAreaStatus,
} from './area.service';

export {
  AREA_STATUSES,
  AREA_TYPES,
  isAreaStatus,
  isAreaType,
} from './area.types';

export {
  isValidAreaCode,
  normalizeAreaCode,
  parseAreaFloorIdParam,
  parseAreaIdParam,
  parseCreateAreaBody,
  parseUpdateAreaBody,
  parseUpdateAreaStatusBody,
} from './area.validation';

export type {
  AreaRecord,
  AreaStatus,
  AreaType,
  CreateAreaInput,
  NewArea,
  PublicArea,
  UpdateAreaInput,
  UpdateAreaStatusInput,
} from './area.types';

export type { ValidationDetail } from './area.validation';
