import { AppError, ERROR_CODES } from '../../shared/errors';

/** A CLOCKED_IN record already exists for the profile (duplicate clock-in). */
export function attendanceActiveAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ATTENDANCE_ACTIVE_ALREADY_EXISTS,
    message: 'An active clock-in already exists for this workforce profile.',
    statusCode: 409,
  });
}

/** Clock-out was attempted without an active (CLOCKED_IN) record. */
export function attendanceNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ATTENDANCE_NOT_ACTIVE,
    message:
      'No active attendance exists for this workforce profile to clock out of.',
    statusCode: 409,
  });
}

/** The Building does not resolve to the profile's Client. */
export function attendanceBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ATTENDANCE_BUILDING_CLIENT_MISMATCH,
    message:
      'The attendance Building does not belong to the workforce profile\u2019s Client.',
    statusCode: 400,
  });
}
