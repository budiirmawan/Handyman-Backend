import { AppError, ERROR_CODES } from '../../shared/errors';

export function entitlementNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENTITLEMENT_NOT_FOUND,
    message: 'Module entitlement not found.',
    statusCode: 404,
  });
}

export function entitlementAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENTITLEMENT_ALREADY_EXISTS,
    message: 'This subscription already has an ACTIVE entitlement for this module.',
    statusCode: 409,
  });
}

export function entitlementCommercialContextInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENTITLEMENT_COMMERCIAL_CONTEXT_INVALID,
    message: 'Cannot activate entitlement: the commercial context is invalid.',
    statusCode: 400,
  });
}
