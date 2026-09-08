import { AppError, ERROR_CODES } from '../../shared/errors';

export function vendorSelectionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_SELECTION_NOT_FOUND,
    message: 'Vendor selection readiness not found.',
    statusCode: 404,
  });
}

export function vendorSelectionRequestInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_SELECTION_REQUEST_INVALID,
    message: 'The referenced Procurement request is invalid.',
    statusCode: 400,
  });
}

export function vendorSelectionVendorInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_SELECTION_VENDOR_INVALID,
    message: 'The referenced Vendor is invalid or belongs to another client.',
    statusCode: 400,
  });
}

export function vendorSelectionAlreadyEvaluatedError(): AppError {
  return new AppError({
    code: ERROR_CODES.VENDOR_SELECTION_ALREADY_EVALUATED,
    message: 'A readiness evaluation for this vendor and request already exists.',
    statusCode: 409,
  });
}
