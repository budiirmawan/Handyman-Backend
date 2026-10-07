import { AppError, ERROR_CODES } from '../../shared/errors';

/** The Work Order has no ACTIVE assignment to act against. */
export function workOrderExecutionNoAssignmentError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EXECUTION_NO_ASSIGNMENT,
    message: 'This work order has no active assignment.',
    statusCode: 400,
  });
}

/** The acting user is not authorized for the current active assignment. */
export function workOrderExecutionUnauthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EXECUTION_UNAUTHORIZED,
    message:
      'The acting user is not authorized for this work order assignment.',
    statusCode: 403,
  });
}

/**
 * The action is not allowed in the Work Order's current lifecycle state (or
 * the Work Order is terminal). Terminal Work Orders cannot receive normal
 * execution actions.
 */
export function workOrderExecutionInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_EXECUTION_INVALID_STATE,
    message: 'This action is not valid in the current work order state.',
    statusCode: 400,
  });
}
