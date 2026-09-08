import { AppError, ERROR_CODES } from '../../shared/errors';

export function workforceProfileNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_PROFILE_NOT_FOUND,
    message: 'Workforce profile not found.',
    statusCode: 404,
  });
}

export function workforceEmployeeCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_EMPLOYEE_CODE_ALREADY_EXISTS,
    message:
      'A workforce profile with this employee code already exists within the organization.',
    statusCode: 409,
  });
}

export function workforceProfileInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_PROFILE_INACTIVE,
    message: 'Inactive workforce profiles cannot be used as operational context.',
    statusCode: 400,
  });
}

export function workforceHierarchyMismatchError(message: string): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_HIERARCHY_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function workforceUserAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_USER_ALREADY_LINKED,
    message: 'This user is already linked to another workforce profile.',
    statusCode: 409,
  });
}
