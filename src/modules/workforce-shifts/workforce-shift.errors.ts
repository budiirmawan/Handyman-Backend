import { AppError, ERROR_CODES } from '../../shared/errors';

export function workforceShiftAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_SHIFT_ASSIGNMENT_NOT_FOUND,
    message: 'Workforce shift assignment not found.',
    statusCode: 404,
  });
}

export function workforceShiftAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_SHIFT_ALREADY_ASSIGNED,
    message: 'This shift is already actively assigned to this workforce profile.',
    statusCode: 409,
  });
}

/**
 * Cross-Client assignment attempt: the Workforce Profile and the Shift resolve
 * to different Clients. Reported as 400 rather than 404 so the caller learns
 * the combination is invalid without revealing anything about the other
 * Client's data.
 */
export function workforceShiftClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_SHIFT_CLIENT_MISMATCH,
    message:
      'The workforce profile and the shift must belong to the same client.',
    statusCode: 400,
  });
}
