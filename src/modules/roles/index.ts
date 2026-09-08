export {
  roleAlreadyAssignedError,
  roleCodeAlreadyExistsError,
  roleInactiveError,
  roleNotFoundError,
} from './role.errors';

export { roleRepository } from './role.repository';

export {
  assignRoleToUser,
  createRole,
  getRoleById,
  listRoles,
  listRolesForUser,
  roleService,
  toPublicRole,
} from './role.service';

export {
  ROLE_STATUSES,
  USER_ROLE_ASSIGNMENT_STATUSES,
  isRoleStatus,
} from './role.types';

export {
  isValidRoleCode,
  isValidUuid,
  normalizeRoleCode,
  parseAssignRoleBody,
  parseCreateRoleBody,
  parseRoleIdParam,
} from './role.validation';

export type {
  CreateRoleInput,
  NewRole,
  PublicRole,
  RoleRecord,
  RoleStatus,
  UserRoleAssignmentRecord,
  UserRoleAssignmentStatus,
} from './role.types';

export type { ValidationDetail } from './role.validation';
