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
