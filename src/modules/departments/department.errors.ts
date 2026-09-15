import { AppError, ERROR_CODES } from '../../shared/errors';

export function departmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.DEPARTMENT_NOT_FOUND,
    message: 'Department not found.',
    statusCode: 404,
  });
}

export function departmentCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.DEPARTMENT_CODE_ALREADY_EXISTS,
    message: 'A department with this code already exists within the organization.',
    statusCode: 409,
  });
}

export function departmentInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.DEPARTMENT_INACTIVE,
    message: 'Inactive departments cannot be used as operational context.',
    statusCode: 400,
  });
}
