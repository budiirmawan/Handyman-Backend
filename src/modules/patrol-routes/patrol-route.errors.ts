import { AppError, ERROR_CODES } from '../../shared/errors';

export function patrolRouteNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_NOT_FOUND,
    message: 'Patrol route not found.',
    statusCode: 404,
  });
}

export function patrolRouteCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_CODE_ALREADY_EXISTS,
    message: 'A patrol route with this code already exists for this building.',
    statusCode: 409,
  });
}

export function patrolRouteInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_INACTIVE,
    message: 'Inactive patrol route cannot be used for new patrol operations.',
    statusCode: 400,
  });
}

export function patrolRouteLocationMismatchError(
  message = 'The referenced location does not belong to this building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_LOCATION_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function patrolRouteBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_BUILDING_MISMATCH,
    message: 'The patrol route belongs to a different building.',
    statusCode: 400,
  });
}

export function patrolRouteStartPostMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_START_POST_MISMATCH,
    message: 'The referenced security post does not belong to this building.',
    statusCode: 400,
  });
}

export function patrolRouteStartPostInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_START_POST_INACTIVE,
    message:
      'Inactive security posts cannot be used as a patrol route start post.',
    statusCode: 400,
  });
}

export function patrolRoutePointNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_POINT_NOT_FOUND,
    message: 'Patrol route point not found.',
    statusCode: 404,
  });
}

export function patrolRoutePointLocationMismatchError(
  message = 'The referenced point location does not belong to this building.',
): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_POINT_LOCATION_MISMATCH,
    message,
    statusCode: 400,
  });
}

export function patrolRoutePointRouteMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_POINT_ROUTE_MISMATCH,
    message: 'The patrol route point does not belong to this route.',
    statusCode: 400,
  });
}

export function patrolRoutePointSequenceInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_POINT_SEQUENCE_INVALID,
    message: 'Patrol route point sequence must be a positive integer.',
    statusCode: 400,
  });
}

export function patrolRoutePointDuplicateSequenceError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_POINT_DUPLICATE_SEQUENCE,
    message: 'A patrol route point with this sequence already exists.',
    statusCode: 409,
  });
}

export function patrolRoutePointInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_ROUTE_POINT_INACTIVE,
    message:
      'Inactive patrol route point cannot be used for new patrol operations.',
    statusCode: 400,
  });
}

export function patrolRouteBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
    message: 'Inactive buildings cannot host new patrol routes.',
    statusCode: 400,
  });
}
