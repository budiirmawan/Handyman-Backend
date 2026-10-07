import { AppError, ERROR_CODES } from '../../shared/errors';

export function workRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_REQUEST_NOT_FOUND,
    message: 'Work request not found.',
    statusCode: 404,
  });
}

export function workRequestNumberAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_REQUEST_NUMBER_ALREADY_EXISTS,
    message: 'A work request with this number already exists for this client.',
    statusCode: 409,
  });
}

/**
 * The Building named in the route does not resolve — through Property →
 * Client — to the Client named in the request. Reported as 400 rather than
 * 404 so the caller learns the combination is invalid without being told
 * anything about the other Client's estate.
 */
export function workRequestBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_REQUEST_BUILDING_CLIENT_MISMATCH,
    message: 'The building does not belong to the specified client.',
    statusCode: 400,
  });
}

/**
 * Only OPEN requests are mutable at intake. A request that is no longer OPEN
 * (already CANCELLED or CONVERTED) cannot have its details changed, and an
 * already-cancelled request cannot be cancelled again.
 */
export function workRequestNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_REQUEST_NOT_OPEN,
    message: 'Only open work requests can be modified.',
    statusCode: 400,
  });
}

/**
 * CONVERTED is terminal for Work Request intake: once a request has become a
 * Work Order (BE-08B) it can no longer be cancelled or edited through the
 * request channel.
 */
export function workRequestTerminalStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORK_REQUEST_TERMINAL_STATE,
    message: 'A converted work request is terminal and cannot be cancelled.',
    statusCode: 400,
  });
}
