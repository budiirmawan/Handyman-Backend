import { AppError, ERROR_CODES } from '../../shared/errors';

/** No Vendor Workforce Binding exists for the addressed pair. */
export function vendorWorkforceBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORKFORCE_BINDING_NOT_FOUND,
    message: 'Vendor workforce binding not found.',
    statusCode: 404,
  });
}

/**
 * The Workforce Profile is already actively bound to this Vendor. Duplicate
 * active bindings are rejected rather than silently stacked; the caller
 * updates or deactivates the existing row instead.
 */
export function vendorWorkforceAlreadyBoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORKFORCE_ALREADY_BOUND,
    message: 'This workforce profile is already actively bound to this vendor.',
    statusCode: 409,
  });
}

/**
 * Cross-Client binding attempt: the Vendor and the Workforce Profile (via
 * Organization) resolve to different Clients. Reported as 400 rather than
 * 404 so the caller learns the combination is invalid without observing
 * another Client's data.
 */
export function vendorWorkforceClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_WORKFORCE_CLIENT_MISMATCH,
    message:
      'The vendor and the workforce profile must belong to the same client.',
    statusCode: 400,
  });
}

/** The vendor's personnel code is already taken within this Vendor. */
export function vendorPersonnelCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_PERSONNEL_CODE_ALREADY_EXISTS,
    message: 'This personnel code is already in use for this vendor.',
    statusCode: 409,
  });
}
