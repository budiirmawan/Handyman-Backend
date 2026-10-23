import { AppError, ERROR_CODES } from '../../shared/errors';

export function permissionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_NOT_FOUND,
    message: 'Permission not found.',
    statusCode: 404,
  });
}

export function permissionCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_CODE_ALREADY_EXISTS,
    message: 'A permission with this code already exists.',
    statusCode: 409,
  });
}

export function permissionInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_INACTIVE,
    message: 'Inactive permissions cannot be assigned.',
    statusCode: 400,
  });
}

export function permissionAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_ALREADY_ASSIGNED,
    message: 'This permission is already assigned to the role.',
    statusCode: 409,
  });
}

export function rolePermissionAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROLE_PERMISSION_ASSIGNMENT_NOT_FOUND,
    message: 'Role permission assignment not found.',
    statusCode: 404,
  });
}

/**
 * CR-HM-BE-IAM-PERMISSION-REVOCATION-01 — a system invariant, not a
 * privilege: an authority-defining permission (`role.manage`,
 * `permission.manage`, `user.manage`, `building.manage`) must keep at least
 * one ACTIVE grant, or the installation would permanently lose that
 * administrative capability. Mirrors LAST_OWNER_ROLE_REQUIRED at the
 * role-permission grant layer. Grant it to another role first.
 */
export function lastAdminPermissionRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.LAST_ADMIN_PERMISSION_REQUIRED,
    message:
      'The last active grant of an administrative permission cannot be revoked. Grant the permission to another role first.',
    statusCode: 409,
  });
}
