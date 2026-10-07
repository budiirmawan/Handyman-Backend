import { AppError, ERROR_CODES } from '../../shared/errors';

export function purchaseRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PURCHASE_REQUEST_NOT_FOUND,
    message: 'Purchase request not found.',
    statusCode: 404,
  });
}

export function purchaseRequestNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PURCHASE_REQUEST_NUMBER_ALREADY_EXISTS,
    message: 'A purchase request with this number already exists for this client.',
    statusCode: 409,
  });
}

/**
 * The Building named in the route does not resolve — through Property →
 * Client — to the Client named in the request. Reported as 400 rather than
 * 404 so the caller learns the combination is invalid without being told
 * anything about the other Client's estate.
 */
export function purchaseRequestBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PURCHASE_REQUEST_BUILDING_CLIENT_MISMATCH,
    message: 'The building does not belong to the specified client.',
    statusCode: 400,
  });
}

/**
 * Only OPEN Purchase Requests are mutable at intake. A request that is no
 * longer OPEN (already CANCELLED) cannot have its details changed, and an
 * already-cancelled request cannot be cancelled again.
 */
export function purchaseRequestNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.PURCHASE_REQUEST_NOT_OPEN,
    message: 'Only open purchase requests can be modified.',
    statusCode: 400,
  });
}
