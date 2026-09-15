import { AppError, ERROR_CODES } from '../../shared/errors';

export function skillNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SKILL_NOT_FOUND,
    message: 'Skill not found.',
    statusCode: 404,
  });
}

export function skillCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SKILL_CODE_ALREADY_EXISTS,
    message: 'A skill with this code already exists for this client.',
    statusCode: 409,
  });
}
