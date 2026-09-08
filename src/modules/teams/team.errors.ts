import { AppError, ERROR_CODES } from '../../shared/errors';

export function teamNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TEAM_NOT_FOUND,
    message: 'Team not found.',
    statusCode: 404,
  });
}

export function teamCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.TEAM_CODE_ALREADY_EXISTS,
    message: 'A team with this code already exists within the department.',
    statusCode: 409,
  });
}

export function teamInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.TEAM_INACTIVE,
    message: 'Inactive teams cannot be used as operational context.',
    statusCode: 400,
  });
}
