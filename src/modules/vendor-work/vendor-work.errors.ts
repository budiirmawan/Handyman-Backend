import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorWorkNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_NOT_FOUND,
    message: 'Vendor work not found.',
    statusCode: 404,
  });
}

/**
 * Vendor Work may only be resolved against an ACTIVE BE-15A assignment. A
 * deactivated (reassigned) assignment can no longer carry work.
 */
export function vendorWorkAssignmentInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_ASSIGNMENT_INACTIVE,
    message: 'Vendor work requires an active vendor assignment.',
    statusCode: 400,
  });
}

/** The requested status change is not an allowed lifecycle transition. */
export function vendorWorkInvalidTransitionError(
  from: string,
  to: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_INVALID_TRANSITION,
    message: `Vendor work cannot transition from ${from} to ${to}.`,
    statusCode: 400,
  });
}

/** The Work Order is not in an assignable lifecycle state. */
export function vendorWorkWorkOrderInvalidStateError(status: string): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_WORK_ORDER_INVALID_STATE,
    message: `Vendor work cannot be created for a work order in the ${status} state.`,
    statusCode: 400,
  });
}

/**
 * The Vendor is not valid for the Work Order's Building (no ACTIVE Vendor ↔
 * Building relationship), or a Vendor / Building filter combination is
 * invalid.
 */
export function vendorWorkBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORK_BUILDING_MISMATCH,
    message: 'The vendor is not related to the work order building.',
    statusCode: 400,
  });
}
