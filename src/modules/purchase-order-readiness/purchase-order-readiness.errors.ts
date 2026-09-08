import { AppError, ERROR_CODES } from '../../shared/errors';

export function poReadinessNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PO_READINESS_NOT_FOUND,
    message: 'Purchase order readiness not found.',
    statusCode: 404,
  });
}

export function poReadinessRequestInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PO_READINESS_REQUEST_INVALID,
    message: 'The referenced Procurement request is invalid.',
    statusCode: 400,
  });
}

export function poReadinessVendorInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PO_READINESS_VENDOR_INVALID,
    message: 'The referenced Vendor is invalid or belongs to another client.',
    statusCode: 400,
  });
}

export function poReadinessAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PO_READINESS_ALREADY_EXISTS,
    message: 'A purchase order readiness for this vendor and request already exists.',
    statusCode: 409,
  });
}

export function poReadinessNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.PO_READINESS_NOT_OPEN,
    message: 'Only READY purchase order readiness records can be updated.',
    statusCode: 400,
  });
}
