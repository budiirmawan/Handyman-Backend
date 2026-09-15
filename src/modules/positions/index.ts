export {
  positionHierarchyMismatchError,
  positionCodeAlreadyExistsError,
  positionInactiveError,
  positionNotFoundError,
} from './position.errors';

export { positionRepository } from './position.repository';

export {
  positionService,
  createPosition,
  getPositionById,
  listPositionsByDepartment,
  listPositionsByOrganization,
  toPublicPosition,
  updatePosition,
} from './position.service';

export { POSITION_STATUSES, isPositionStatus } from './position.types';

export {
  isValidPositionCode,
  isValidUuid,
  normalizePositionCode,
  parseCreatePositionBody,
  parseDepartmentIdParam,
  parseOrganizationIdParam,
  parsePositionIdParam,
  parseUpdatePositionBody,
} from './position.validation';

export type { CreatePositionBody, UpdatePositionBody } from './position.validation';

export type {
  CreatePositionInput,
  NewPosition,
  PositionRecord,
  PositionStatus,
  PublicPosition,
  UpdatePositionInput,
} from './position.types';
