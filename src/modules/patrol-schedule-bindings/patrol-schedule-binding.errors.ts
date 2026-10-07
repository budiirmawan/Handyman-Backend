import { AppError, ERROR_CODES } from '../../shared/errors';

export function patrolScheduleBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_SCHEDULE_BINDING_NOT_FOUND,
    message: 'Patrol schedule binding not found.',
    statusCode: 404,
  });
}

export function patrolScheduleBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_SCHEDULE_BINDING_ALREADY_EXISTS,
    message:
      'An active patrol schedule binding already exists for this schedule definition.',
    statusCode: 409,
  });
}

export function patrolScheduleBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_SCHEDULE_BINDING_INACTIVE,
    message:
      'Inactive patrol schedule binding cannot be used for operational activity.',
    statusCode: 400,
  });
}

export function patrolScheduleNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_SCHEDULE_NOT_FOUND,
    message: 'Schedule definition not found.',
    statusCode: 404,
  });
}

export function patrolScheduleInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_SCHEDULE_INACTIVE,
    message: 'Inactive schedule cannot be bound to a patrol route.',
    statusCode: 400,
  });
}

export function patrolScheduleClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_SCHEDULE_CLIENT_MISMATCH,
    message: 'The schedule definition belongs to a different client.',
    statusCode: 400,
  });
}

export function patrolScheduleBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_SCHEDULE_BUILDING_MISMATCH,
    message: 'The schedule definition belongs to a different building.',
    statusCode: 400,
  });
}

export function patrolScheduleTargetMismatchError(
  message = 'The schedule target is not compatible with the patrol route building context.',
): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_SCHEDULE_TARGET_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function patrolRouteHasNoPointsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_HAS_NO_POINTS,
    message: 'Patrol route must have at least one active point to be bound.',
    statusCode: 400,
  });
}

export function patrolRouteBindingBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_BINDING_BUILDING_MISMATCH,
    message: 'The patrol route belongs to a different building.',
    statusCode: 400,
  });
}
