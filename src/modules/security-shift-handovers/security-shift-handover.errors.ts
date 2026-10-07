import { AppError, ERROR_CODES } from '../../shared/errors';

/** The binding row could not be located. */
export function securityShiftHandoverBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_SHIFT_HANDOVER_BINDING_NOT_FOUND,
    message: 'Security shift handover binding not found.',
    statusCode: 404,
  });
}

/** A same-handover ACTIVE binding already exists. */
export function securityShiftHandoverBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_SHIFT_HANDOVER_BINDING_ALREADY_EXISTS,
    message:
      'An active security shift handover binding already exists for this handover.',
    statusCode: 409,
  });
}

/** The referenced BE-10J shift_handovers row belongs to a different Building. */
export function securityShiftHandoverBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_SHIFT_HANDOVER_BUILDING_MISMATCH,
    message:
      'The shift handover does not belong to the same building as the binding.',
    statusCode: 400,
  });
}

/** The start Security Post is in a different Building than the handover. */
export function securityShiftHandoverStartPostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_SHIFT_HANDOVER_START_POST_BUILDING_MISMATCH,
    message:
      'The security start post does not belong to the same building as the handover.',
    statusCode: 400,
  });
}

/** The start Security Post exists but is not ACTIVE. */
export function securityShiftHandoverStartPostInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_SHIFT_HANDOVER_START_POST_INACTIVE,
    message: 'The security start post must be ACTIVE.',
    statusCode: 400,
  });
}

/** The optional Patrol Route is in a different Building than the handover. */
export function securityShiftHandoverPatrolRouteBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_SHIFT_HANDOVER_PATROL_ROUTE_BUILDING_MISMATCH,
    message:
      'The patrol route does not belong to the same building as the handover.',
    statusCode: 400,
  });
}

/** The optional Patrol Route exists but is not ACTIVE. */
export function securityShiftHandoverPatrolRouteInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_SHIFT_HANDOVER_PATROL_ROUTE_INACTIVE,
    message: 'The patrol route must be ACTIVE.',
    statusCode: 400,
  });
}
