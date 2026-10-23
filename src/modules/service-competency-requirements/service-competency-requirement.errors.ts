import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — competency-requirement errors.
 *
 * All failures are structured (code + HTTP status) so the Web/Mobile clients
 * can distinguish "you cannot see this job type" (403) from "the requirement
 * does not exist" (404) from "the requirement conflicts with an existing one"
 * (409) without string matching.
 */

export function competencyRequirementNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_COMPETENCY_REQUIREMENT_NOT_FOUND,
    message: 'Competency requirement not found for this service catalog entry.',
    statusCode: 404,
  });
}

export function competencyRequirementAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_COMPETENCY_REQUIREMENT_ALREADY_EXISTS,
    message:
      'An ACTIVE competency requirement for this skill or certificate already ' +
      'exists on the service catalog entry.',
    statusCode: 409,
  });
}

export function competencyRequirementInvalidStateError(
  message: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_COMPETENCY_REQUIREMENT_INVALID_STATE,
    message,
    statusCode: 409,
  });
}

export function competencyRequirementSkillMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_COMPETENCY_REQUIREMENT_SKILL_MISMATCH,
    message:
      'The requirement skill must belong to the same Client as the service ' +
      'catalog entry.',
    statusCode: 400,
  });
}

export function competencyRequirementServiceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SERVICE_COMPETENCY_REQUIREMENT_SERVICE_INACTIVE,
    message:
      'Competency requirements can only be configured on an ACTIVE service ' +
      'catalog entry.',
    statusCode: 409,
  });
}
