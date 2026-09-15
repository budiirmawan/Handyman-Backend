import { AppError, ERROR_CODES } from '../../shared/errors';

/** The Security link row could not be located. */
export function securityFindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_FINDING_NOT_FOUND,
    message: 'Security finding not found.',
    statusCode: 404,
  });
}

/** The BE-09 Finding is already bound to a Security context. */
export function securityFindingAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_FINDING_ALREADY_LINKED,
    message: 'The finding already has a security context.',
    statusCode: 409,
  });
}

/** A Security Finding already exists for the same source execution. */
export function securityFindingSourceAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_FINDING_SOURCE_ALREADY_LINKED,
    message: 'A security finding already exists for this source.',
    statusCode: 409,
  });
}

/** The Security source does not belong to the requested Building. */
export function securityFindingBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_FINDING_BUILDING_MISMATCH,
    message: 'The security source does not belong to the requested building.',
    statusCode: 400,
  });
}

/** The Security source does not exist. */
export function securityFindingSourceNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_FINDING_SOURCE_NOT_FOUND,
    message: 'The security source could not be found.',
    statusCode: 404,
  });
}

/** The start Security Post is in a different Building than the Finding. */
export function securityFindingStartPostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_FINDING_START_POST_BUILDING_MISMATCH,
    message:
      'The security start post does not belong to the same building as the finding.',
    statusCode: 400,
  });
}

/** The optional Patrol Route is in a different Building than the Finding. */
export function securityFindingPatrolRouteBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_FINDING_PATROL_ROUTE_BUILDING_MISMATCH,
    message:
      'The patrol route does not belong to the same building as the finding.',
    statusCode: 400,
  });
}
