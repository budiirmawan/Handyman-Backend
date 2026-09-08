import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorPicNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_PIC_NOT_FOUND,
    message: 'Vendor PIC not found.',
    statusCode: 404,
  });
}

export function vendorPicInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_PIC_INACTIVE,
    message: 'An inactive vendor PIC cannot be the primary contact.',
    statusCode: 400,
  });
}
