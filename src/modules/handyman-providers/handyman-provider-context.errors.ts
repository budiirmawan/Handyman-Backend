import { AppError, ERROR_CODES } from '../../shared/errors';

/** Vendor authority row not resolvable for the requested context. */
export function handymanProviderVendorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_NOT_FOUND,
    message: 'Vendor not found.',
    statusCode: 404,
  });
}

/** The vendor already carries its single Handyman provider context (409). */
export function handymanProviderContextAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PROVIDER_CONTEXT_ALREADY_EXISTS,
    message: 'This vendor already has a Handyman provider context.',
    statusCode: 409,
  });
}

/** Referenced provider context not found. */
export function handymanProviderContextNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PROVIDER_CONTEXT_NOT_FOUND,
    message: 'Handyman provider context not found.',
    statusCode: 404,
  });
}

/** Status payload invalid or same-state (ACTIVE → ACTIVE etc.). */
export function handymanProviderContextInvalidStatusError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_PROVIDER_CONTEXT_INVALID_STATUS,
    message:
      'status must be ACTIVE or INACTIVE and must change the current state.',
    statusCode: 400,
  });
}
