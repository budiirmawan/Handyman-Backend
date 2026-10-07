import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * The Shift named in the query belongs to a different Building than the one
 * named in the route. Reported as 400 so the caller learns the combination is
 * invalid without being told anything about another Building's shifts.
 */
export function engineeringShiftBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ENGINEERING_SHIFT_BUILDING_MISMATCH,
    message: 'The shift does not belong to the requested building.',
    statusCode: 400,
  });
}
