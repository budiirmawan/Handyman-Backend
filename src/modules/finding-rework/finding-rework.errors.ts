import { AppError, ERROR_CODES } from '../../shared/errors';
export function findingReworkInvalidStateError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REWORK_INVALID_STATE, message: 'Finding state does not allow this rework action.', statusCode: 400 });
}
export function findingReworkAlreadyOpenError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REWORK_ALREADY_OPEN, message: 'Finding already has a current rework cycle.', statusCode: 409 });
}
export function findingReworkNotFoundError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REWORK_NOT_FOUND, message: 'Finding has no current rework cycle.', statusCode: 404 });
}
export function findingReworkUnauthorizedError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REWORK_UNAUTHORIZED, message: 'Only the active responsible party may perform this rework action.', statusCode: 403 });
}
export function findingReworkImmutableError(): AppError {
  return new AppError({ code: ERROR_CODES.FINDING_REWORK_IMMUTABLE, message: 'A completed rework cycle cannot be modified.', statusCode: 409 });
}
