import { AppError, ERROR_CODES } from '../../shared/errors';

export function dailyCleaningNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.DAILY_CLEANING_NOT_FOUND,
    message: 'Daily cleaning task not found.',
    statusCode: 404,
  });
}

export function dailyCleaningTaskMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.DAILY_CLEANING_TASK_MISMATCH,
    message: 'Task does not belong to a valid cleaning schedule binding.',
    statusCode: 400,
  });
}

export function dailyCleaningInvalidDateError(): AppError {
  return new AppError({
    code: ERROR_CODES.DAILY_CLEANING_INVALID_DATE,
    message: 'Operational date must be a valid YYYY-MM-DD format.',
    statusCode: 400,
  });
}
