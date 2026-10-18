import { AppError, ERROR_CODES } from '../../shared/errors';

export function roleNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROLE_NOT_FOUND,
    message: 'Role not found.',
    statusCode: 404,
  });
}

export function roleCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROLE_CODE_ALREADY_EXISTS,
    message: 'A role with this code already exists.',
    statusCode: 409,
  });
}

export function roleInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROLE_INACTIVE,
    message: 'Inactive roles cannot be assigned.',
    statusCode: 400,
  });
}

export function roleAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROLE_ALREADY_ASSIGNED,
    message: 'This role is already assigned to the user.',
    statusCode: 409,
  });
}

export function roleAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ROLE_ASSIGNMENT_NOT_FOUND,
    message: 'This role is not assigned to the user.',
    statusCode: 404,
  });
}

/**
 * A system invariant, not a privilege: the PLATFORM_ADMIN role is the only
 * role that can administer identity/authority, so the last ACTIVE assignment
 * must not be revoked. Assign the role to a second owner first.
 */
export function lastOwnerRoleRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.LAST_OWNER_ROLE_REQUIRED,
    message:
      'The last active PLATFORM_ADMIN assignment cannot be revoked. Assign the role to another owner first.',
    statusCode: 409,
  });
}
