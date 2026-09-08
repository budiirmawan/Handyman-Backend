import { AppError, ERROR_CODES } from '../../shared/errors';

export function workforceSkillAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_SKILL_ASSIGNMENT_NOT_FOUND,
    message: 'Workforce skill assignment not found.',
    statusCode: 404,
  });
}

export function workforceSkillAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_SKILL_ALREADY_ASSIGNED,
    message: 'This skill is already actively assigned to this workforce profile.',
    statusCode: 409,
  });
}

/**
 * Cross-Client assignment attempt: the Workforce Profile and the Skill resolve
 * to different Clients. Reported as 400 rather than 404 so the caller learns
 * the combination is invalid without revealing anything about the other
 * Client's data.
 */
export function workforceSkillClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_SKILL_CLIENT_MISMATCH,
    message:
      'The workforce profile and the skill must belong to the same client.',
    statusCode: 400,
  });
}

export function skillInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SKILL_INACTIVE,
    message: 'Inactive skills cannot be assigned to a workforce profile.',
    statusCode: 400,
  });
}
