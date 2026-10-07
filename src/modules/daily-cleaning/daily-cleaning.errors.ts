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

/**
 * CR-BE-RN13-CLEANING-FIELD-01 PART 00 — a generated cleaning task resolved to
 * more than one Cleaning Area.
 *
 * Migration 0352 makes this impossible through the API by allowing only one
 * ACTIVE cleaning schedule binding per schedule definition. If it is ever
 * observed the data is corrupted (for example a row written before 0352 that
 * bypassed the migration guard), and the caller must get an explicit failure
 * rather than an arbitrary area silently chosen from the join.
 */
export function dailyCleaningAreaAmbiguousError(taskId: string): AppError {
  return new AppError({
    code: ERROR_CODES.DAILY_CLEANING_AREA_AMBIGUOUS,
    message:
      `Generated cleaning task ${taskId} resolves to more than one active ` +
      'cleaning schedule binding. Exactly one cleaning area per generated ' +
      'cleaning task is required; the binding data is corrupted.',
    statusCode: 409,
  });
}

export function dailyCleaningInvalidDateError(): AppError {
  return new AppError({
    code: ERROR_CODES.DAILY_CLEANING_INVALID_DATE,
    message: 'Operational date must be a valid YYYY-MM-DD format.',
    statusCode: 400,
  });
}
