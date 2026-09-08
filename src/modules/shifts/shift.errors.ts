import { AppError, ERROR_CODES } from '../../shared/errors';

export function shiftNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_NOT_FOUND,
    message: 'Shift not found.',
    statusCode: 404,
  });
}

export function shiftCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_CODE_ALREADY_EXISTS,
    message: 'A shift with this code already exists for this building.',
    statusCode: 409,
  });
}

/**
 * The Building named in the route does not resolve — through Property → Client
 * — to the Client named in the request. Reported as 400 rather than 404 so the
 * caller learns the combination is invalid without being told anything about
 * the other Client's estate.
 */
export function shiftBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_BUILDING_CLIENT_MISMATCH,
    message: 'The building does not belong to the specified client.',
    statusCode: 400,
  });
}

export function shiftInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SHIFT_INACTIVE,
    message: 'Inactive shifts cannot be assigned to a workforce profile.',
    statusCode: 400,
  });
}
