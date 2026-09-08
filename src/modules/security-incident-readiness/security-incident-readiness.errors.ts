import { AppError, ERROR_CODES } from '../../shared/errors';

/** The readiness configuration could not be located. */
export function securityIncidentReadinessNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_NOT_FOUND,
    message: 'Security incident readiness not found.',
    statusCode: 404,
  });
}

/** An active readiness row already exists for the same (post, category). */
export function securityIncidentReadinessAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_ALREADY_EXISTS,
    message:
      'An active security incident readiness already exists for this post and category.',
    statusCode: 409,
  });
}

/** The readiness row is for a different Building. */
export function securityIncidentReadinessBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_BUILDING_MISMATCH,
    message: 'The readiness row does not belong to the requested building.',
    statusCode: 400,
  });
}

/** The optional Security Post is in a different Building. */
export function securityIncidentReadinessSecurityPostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_SECURITY_POST_BUILDING_MISMATCH,
    message:
      'The security post does not belong to the same building as the readiness row.',
    statusCode: 400,
  });
}

/** The Security Post exists but is INACTIVE. */
export function securityIncidentReadinessSecurityPostInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_SECURITY_POST_INACTIVE,
    message: 'Inactive security posts cannot anchor readiness configuration.',
    statusCode: 400,
  });
}

/** The responsible Team exists but is INACTIVE. */
export function securityIncidentReadinessTeamInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_TEAM_INACTIVE,
    message: 'Inactive teams cannot be the responsible team for readiness.',
    statusCode: 400,
  });
}

/** The responsible Team does not have an active Building assignment. */
export function securityIncidentReadinessTeamBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_TEAM_BUILDING_MISMATCH,
    message:
      'The responsible team has no active building assignment for this building.',
    statusCode: 400,
  });
}

/** The responsible Workforce Profile exists but is INACTIVE. */
export function securityIncidentReadinessWorkforceInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_WORKFORCE_INACTIVE,
    message: 'Inactive workforce profiles cannot be the responsible workforce for readiness.',
    statusCode: 400,
  });
}

/** The responsible Workforce has no active Building assignment. */
export function securityIncidentReadinessWorkforceBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_WORKFORCE_BUILDING_MISMATCH,
    message:
      'The responsible workforce has no active building assignment for this building.',
    statusCode: 400,
  });
}

/** The supplied category is not in the allowed enum. */
export function securityIncidentReadinessCategoryInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_CATEGORY_INVALID,
    message: 'Incident readiness category is invalid.',
    statusCode: 400,
  });
}

/** The supplied readiness_status is not in the allowed enum. */
export function securityIncidentReadinessStatusInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.SECURITY_INCIDENT_READINESS_STATUS_INVALID,
    message: 'Incident readiness status is invalid.',
    statusCode: 400,
  });
}
