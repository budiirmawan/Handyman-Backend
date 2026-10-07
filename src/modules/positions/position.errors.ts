import { AppError, ERROR_CODES } from '../../shared/errors';

export function positionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.POSITION_NOT_FOUND,
    message: 'Position not found.',
    statusCode: 404,
  });
}

export function positionCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.POSITION_CODE_ALREADY_EXISTS,
    message: 'A position with this code already exists within the organization.',
    statusCode: 409,
  });
}

export function positionInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.POSITION_INACTIVE,
    message: 'Inactive positions cannot be used as operational context.',
    statusCode: 400,
  });
}

export function positionHierarchyMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.POSITION_HIERARCHY_MISMATCH,
    message: 'The provided department does not belong to the specified organization.',
    statusCode: 400,
  });
}
