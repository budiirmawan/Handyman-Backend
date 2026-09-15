import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorChecklistBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CHECKLIST_BINDING_NOT_FOUND,
    message: 'Vendor checklist binding not found.',
    statusCode: 404,
  });
}

export function vendorChecklistBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CHECKLIST_BINDING_ALREADY_EXISTS,
    message:
      'An active vendor checklist binding already exists for this vendor work and template.',
    statusCode: 409,
  });
}

export function vendorChecklistBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CHECKLIST_BINDING_INACTIVE,
    message: 'Inactive vendor checklist bindings cannot start executions.',
    statusCode: 400,
  });
}

/** The Vendor Work is COMPLETED (terminal for BE-15B) and cannot receive a binding. */
export function vendorChecklistVendorWorkCompletedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CHECKLIST_VENDOR_WORK_COMPLETED,
    message: 'Completed vendor work cannot receive a checklist binding.',
    statusCode: 400,
  });
}

/**
 * The Checklist Template belongs to a different Client than the Vendor Work's
 * Building. Reported as 400 so the caller learns the combination is invalid
 * without observing another Client's data.
 */
export function vendorChecklistBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CHECKLIST_BUILDING_MISMATCH,
    message: 'The checklist template does not belong to the vendor work building.',
    statusCode: 400,
  });
}

export function vendorChecklistExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CHECKLIST_EXECUTION_NOT_FOUND,
    message: 'Checklist execution is not linked to a vendor checklist binding.',
    statusCode: 404,
  });
}
