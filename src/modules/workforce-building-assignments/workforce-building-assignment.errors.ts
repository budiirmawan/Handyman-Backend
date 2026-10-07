import { AppError, ERROR_CODES } from '../../shared/errors';

/** No Workforce Building Assignment exists for the addressed pair. */
export function workforceBuildingAssignmentNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_BUILDING_ASSIGNMENT_NOT_FOUND,
    message: 'Workforce building assignment not found.',
    statusCode: 404,
  });
}

/**
 * The Workforce Profile already holds this Building on an ACTIVE assignment.
 * Duplicate active placements are rejected rather than silently stacked; the
 * caller updates or deactivates the existing row instead.
 */
export function workforceBuildingAlreadyAssignedError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_BUILDING_ALREADY_ASSIGNED,
    message:
      'This workforce profile is already actively assigned to this building.',
    statusCode: 409,
  });
}

/**
 * Cross-Client assignment attempt: the Workforce Profile (via Organization)
 * and the Building (via Property) resolve to different Clients. Reported as
 * 400 rather than 404 so the caller learns the combination is invalid without
 * observing another Client's data.
 */
export function workforceBuildingClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_BUILDING_CLIENT_MISMATCH,
    message:
      'The workforce profile and the building must belong to the same client.',
    statusCode: 400,
  });
}

/**
 * The Building is INACTIVE, so nobody can be operationally assigned to it.
 * Distinct from BE-02F's `BUILDING_NOT_AVAILABLE`, which is about a User's
 * access grant, not an operational placement.
 */
export function workforceBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.WORKFORCE_BUILDING_INACTIVE,
    message: 'Building is inactive and cannot receive workforce assignments.',
    statusCode: 400,
  });
}
