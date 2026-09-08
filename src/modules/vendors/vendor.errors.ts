import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_NOT_FOUND,
    message: 'Vendor not found.',
    statusCode: 404,
  });
}

export function vendorCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CODE_ALREADY_EXISTS,
    message: 'A vendor with this code already exists for this client.',
    statusCode: 409,
  });
}

export function vendorInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_INACTIVE,
    message: 'Vendor is inactive.',
    statusCode: 400,
  });
}
