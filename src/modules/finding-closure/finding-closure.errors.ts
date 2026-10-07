import { AppError, ERROR_CODES } from '../../shared/errors';

export function findingCloseInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_CLOSE_INVALID_STATE,
    message: 'Only a verified Finding may be closed.',
    statusCode: 400,
  });
}
export function findingCloseNotApprovedError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_CLOSE_NOT_APPROVED,
    message: 'Finding closure requires the latest verification to be approved.',
    statusCode: 400,
  });
}
export function findingCloseReworkPendingError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_CLOSE_REWORK_PENDING,
    message: 'Finding cannot close while a rework cycle is pending.',
    statusCode: 400,
  });
}
export function findingCloseAlreadyClosedError(): AppError {
  return new AppError({
    code: ERROR_CODES.FINDING_CLOSE_ALREADY_CLOSED,
    message: 'Finding is already closed.',
    statusCode: 409,
  });
}
