import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_ASSIGNMENT_NOT_FOUND,
    message: 'Vendor assignment not found.',
    statusCode: 404,
  });
}

/**
 * The same Vendor already holds an ACTIVE assignment for the same Work Order.
 * Reported as 409 — reassign/deactivate the existing assignment first.
 */
export function vendorAssignmentAlreadyActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_ASSIGNMENT_ALREADY_ACTIVE,
    message: 'This vendor already has an active assignment for the work order.',
    statusCode: 409,
  });
}

/** The target assignment is already INACTIVE (only ACTIVE may be reassigned). */
export function vendorAssignmentNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_ASSIGNMENT_NOT_ACTIVE,
    message: 'Only an active vendor assignment can be reassigned.',
    statusCode: 400,
  });
}

/** The Work Order is not in an assignable lifecycle state. */
export function vendorAssignmentWorkOrderInvalidStateError(
  status: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_ASSIGNMENT_WORK_ORDER_INVALID_STATE,
    message: `Work orders in the ${status} state cannot be assigned to a vendor.`,
    statusCode: 400,
  });
}

/**
 * The Vendor resolves to a different Client than the Work Order. Reported as
 * 400 rather than 404 so the caller learns the combination is invalid without
 * observing another Client's data.
 */
export function vendorAssignmentClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_ASSIGNMENT_CLIENT_MISMATCH,
    message: 'The vendor does not belong to the work order client.',
    statusCode: 400,
  });
}

/** The Vendor holds no ACTIVE relationship to the Work Order's Building. */
export function vendorAssignmentBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_ASSIGNMENT_BUILDING_MISMATCH,
    message: 'The vendor is not related to the work order building.',
    statusCode: 400,
  });
}
