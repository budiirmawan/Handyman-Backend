import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorCategoryNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CATEGORY_NOT_FOUND,
    message: 'Vendor category not found.',
    statusCode: 404,
  });
}

export function vendorCategoryCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CATEGORY_CODE_ALREADY_EXISTS,
    message: 'A vendor category with this code already exists for this client.',
    statusCode: 409,
  });
}

export function vendorCategoryInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CATEGORY_INACTIVE,
    message: 'Inactive vendor categories cannot be assigned to vendors.',
    statusCode: 400,
  });
}

export function vendorCategoryClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_CATEGORY_CLIENT_MISMATCH,
    message: 'Vendor and vendor category must belong to the same client.',
    statusCode: 400,
  });
}
