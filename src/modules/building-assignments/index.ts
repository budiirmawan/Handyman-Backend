export {
  buildingNotAvailableError,
  userBuildingAlreadyAssignedError,
  userBuildingAssignmentNotFoundError,
} from './building-assignment.errors';

export { buildingAssignmentRepository } from './building-assignment.repository';

export {
  buildingAssignmentService,
  createAssignment,
  deactivateAssignment,
  listUserAssignments,
  resolveBuildingsForUser,
  toPublicAssignment,
} from './building-assignment.service';

export {
  USER_BUILDING_ASSIGNMENT_STATUSES,
  isUserBuildingAssignmentStatus,
} from './building-assignment.types';

export {
  parseAssignmentBuildingIdParam,
  parseAssignmentUserIdParam,
  parseCreateAssignmentBody,
} from './building-assignment.validation';

export type {
  CreateUserBuildingAssignmentInput,
  NewUserBuildingAssignment,
  PublicUserBuildingAssignment,
  UserBuildingAssignmentRecord,
  UserBuildingAssignmentStatus,
  UserBuildingContext,
} from './building-assignment.types';

export type { ValidationDetail } from './building-assignment.validation';
