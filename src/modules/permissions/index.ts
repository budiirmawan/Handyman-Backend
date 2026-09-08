export {
  permissionAlreadyAssignedError,
  permissionCodeAlreadyExistsError,
  permissionInactiveError,
  permissionNotFoundError,
  rolePermissionAssignmentNotFoundError,
} from './permission.errors';

export { permissionRepository } from './permission.repository';

export {
  assignPermissionToRole,
  createPermission,
  getPermissionById,
  listPermissions,
  listPermissionsForRole,
  permissionService,
  resolvePermissionsForUser,
  toPublicPermission,
} from './permission.service';

export {
  PERMISSION_STATUSES,
  ROLE_PERMISSION_ASSIGNMENT_STATUSES,
  isPermissionStatus,
} from './permission.types';

export {
  isValidPermissionCode,
  isValidUuid,
  normalizePermissionCode,
  parseAssignPermissionBody,
  parseCreatePermissionBody,
  parsePermissionIdParam,
  parseRoleIdParam,
} from './permission.validation';

export type {
  CreatePermissionInput,
  NewPermission,
  PermissionRecord,
  PermissionStatus,
  PublicPermission,
  RolePermissionAssignmentRecord,
  RolePermissionAssignmentStatus,
} from './permission.types';

export type { ValidationDetail } from './permission.validation';
