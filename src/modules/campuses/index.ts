export {
  campusCodeAlreadyExistsError,
  campusInactiveError,
  campusNotFoundError,
  campusPropertyInactiveError,
  campusPropertyMismatchError,
} from './campus.errors';

export { campusRepository } from './campus.repository';

export {
  campusService,
  createCampus,
  getCampusById,
  listCampusesByProperty,
  setBuildingCampus,
  toPublicCampus,
  updateCampus,
  updateCampusStatus,
} from './campus.service';

export { CAMPUS_STATUSES, isCampusStatus } from './campus.types';

export {
  isValidCampusCode,
  normalizeCampusCode,
  parseCampusIdParam,
  parseCampusPropertyIdParam,
  parseCreateCampusBody,
  parseSetBuildingCampusBody,
  parseUpdateCampusBody,
  parseUpdateCampusStatusBody,
} from './campus.validation';

export type {
  CampusRecord,
  CampusStatus,
  CreateCampusInput,
  NewCampus,
  PublicCampus,
  SetBuildingCampusInput,
  UpdateCampusInput,
  UpdateCampusStatusInput,
} from './campus.types';

export type { ValidationDetail } from './campus.validation';
