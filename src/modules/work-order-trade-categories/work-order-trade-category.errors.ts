import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — trade registry + classification
 * errors.
 *
 * Competency requirement configuration on a trade category reuses the PART 03A
 * requirement codes (`SERVICE_COMPETENCY_REQUIREMENT_*`): it is the same model
 * with a second target, so a client that already handles those codes handles
 * these too.
 */

export function workOrderTradeCategoryNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_TRADE_CATEGORY_NOT_FOUND,
    message: 'Work order trade category not found.',
    statusCode: 404,
  });
}

export function workOrderTradeCategoryAlreadyExistsError(
  code: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_TRADE_CATEGORY_ALREADY_EXISTS,
    message: `A trade category with code ${code} already exists.`,
    statusCode: 409,
  });
}

export function workOrderTradeCategoryInvalidStateError(
  message: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_TRADE_CATEGORY_INVALID_STATE,
    message,
    statusCode: 409,
  });
}

export function workOrderTradeCategoryInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_TRADE_CATEGORY_INVALID_STATE,
    message:
      'An INACTIVE trade category can no longer be assigned to a Work Order. ' +
      'Reactivate it or classify the Work Order with an ACTIVE trade.',
    statusCode: 409,
  });
}
