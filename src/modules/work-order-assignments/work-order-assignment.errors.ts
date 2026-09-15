import { AppError, ERROR_CODES } from '../../shared/errors';

export function workOrderAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_ASSIGNMENT_NOT_FOUND,
    message: 'Work order assignment not found.',
    statusCode: 404,
  });
}

/**
 * The Work Order is not in an assignable lifecycle state (e.g. COMPLETED,
 * CANCELLED, CLOSED).
 */
export function workOrderAssignmentInvalidStateError(
  status: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_ASSIGNMENT_INVALID_STATE,
    message: `Work orders in the ${status} state cannot be assigned.`,
    statusCode: 400,
  });
}

/**
 * The assignee resolves to a different Client than the Work Order. Reported
 * as 400 rather than 404 so the caller learns the combination is invalid
 * without observing another Client's data.
 */
export function workOrderAssignmentClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_ASSIGNMENT_CLIENT_MISMATCH,
    message: 'The assignee does not belong to the work order client.',
    statusCode: 400,
  });
}

/**
 * The assignee is not placed (workforce) or related (vendor) to the Work
 * Order's Building.
 */
export function workOrderAssignmentBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_ASSIGNMENT_BUILDING_MISMATCH,
    message: 'The assignee is not available for the work order building.',
    statusCode: 400,
  });
}

/**
 * A VENDOR_WORKFORCE assignment references a Workforce Profile that is not
 * bound to the selected Vendor.
 */
export function workOrderAssignmentVendorWorkforceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_ASSIGNMENT_VENDOR_WORKFORCE_MISMATCH,
    message: 'The workforce profile is not bound to the selected vendor.',
    statusCode: 400,
  });
}

/** A Work Order already has one ACTIVE assignment. */
export function workOrderAssignmentAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_ORDER_ASSIGNMENT_ALREADY_ASSIGNED,
    message: 'This work order already has an active assignment.',
    statusCode: 409,
  });
}
