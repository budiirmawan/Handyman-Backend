import { AppError, ERROR_CODES } from '../../shared/errors';

export function patrolExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_NOT_FOUND,
    message: 'Patrol execution not found.',
    statusCode: 404,
  });
}

export function patrolExecutionRouteInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_ROUTE_INACTIVE,
    message:
      'Inactive patrol route cannot be the subject of a new execution.',
    statusCode: 400,
  });
}

export function patrolExecutionBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_BINDING_INACTIVE,
    message:
      'Inactive patrol schedule binding cannot be the subject of a new execution.',
    statusCode: 400,
  });
}

export function patrolExecutionBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_BUILDING_MISMATCH,
    message: 'The patrol execution belongs to a different building.',
    statusCode: 400,
  });
}

export function patrolExecutionClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_CLIENT_MISMATCH,
    message: 'The patrol execution belongs to a different client.',
    statusCode: 400,
  });
}

export function patrolExecutionTerminalError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_TERMINAL,
    message: 'Terminal patrol execution cannot be restarted.',
    statusCode: 400,
  });
}

export function patrolExecutionNoAssignmentError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_NO_ASSIGNMENT,
    message: 'Patrol execution has no active assignment.',
    statusCode: 400,
  });
}

export function patrolExecutionUnauthorizedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_UNAUTHORIZED,
    message: 'User is not the assigned workforce for this patrol execution.',
    statusCode: 403,
  });
}

export function patrolExecutionInvalidStateError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_INVALID_STATE,
    message: 'Patrol execution is in an invalid state for this transition.',
    statusCode: 400,
  });
}

export function patrolExecutionIncompleteError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_EXECUTION_INCOMPLETE,
    message:
      'Patrol execution cannot be completed while required route points are still pending.',
    statusCode: 400,
  });
}

export function patrolPointVisitNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_POINT_VISIT_NOT_FOUND,
    message: 'Patrol point visit not found.',
    statusCode: 404,
  });
}

export function patrolPointVisitDuplicateError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_POINT_VISIT_DUPLICATE,
    message: 'This patrol point has already been visited for this execution.',
    statusCode: 409,
  });
}

export function patrolPointVisitRouteMismatchError(
  message = 'Patrol point does not belong to the route of this execution.',
): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_POINT_VISIT_ROUTE_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function patrolPointVisitExecutionMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_POINT_VISIT_EXECUTION_MISMATCH,
    message: 'Patrol point visit does not belong to this execution.',
    statusCode: 400,
  });
}

export function patrolPointVisitTerminalError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_POINT_VISIT_TERMINAL,
    message: 'Cannot record point visits on a terminal patrol execution.',
    statusCode: 400,
  });
}
