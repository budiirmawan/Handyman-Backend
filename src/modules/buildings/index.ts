export {
  buildingCodeAlreadyExistsError,
  buildingNotFoundError,
} from './building.errors';

export { buildingRepository } from './building.repository';

export {
  buildingService,
  createBuilding,
  getBuildingById,
  listBuildings,
  listBuildingsByProperty,
  toPublicBuilding,
  updateBuildingStatus,
} from './building.service';

export {
  BUILDING_STATUSES,
  isBuildingStatus,
} from './building.types';

export {
  isValidBuildingCode,
  isValidTimeZone,
  normalizeBuildingCode,
  parseBuildingIdParam,
  parseBuildingPropertyIdParam,
  parseCreateBuildingBody,
  parseUpdateBuildingStatusBody,
} from './building.validation';

export type {
  BuildingRecord,
  BuildingStatus,
  CreateBuildingInput,
  NewBuilding,
  PublicBuilding,
  UpdateBuildingStatusInput,
} from './building.types';

export type { ValidationDetail } from './building.validation';
