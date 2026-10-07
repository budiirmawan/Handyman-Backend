import { AppError, ERROR_CODES } from '../../shared/errors';

export function patrolChecklistBindingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_BINDING_NOT_FOUND,
    message: 'Patrol checklist binding not found.',
    statusCode: 404,
  });
}

export function patrolChecklistBindingAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_BINDING_ALREADY_EXISTS,
    message:
      'An active patrol checklist binding already exists for this template and route.',
    statusCode: 409,
  });
}

export function patrolChecklistBindingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_BINDING_INACTIVE,
    message: 'Inactive patrol checklist bindings cannot start executions.',
    statusCode: 400,
  });
}

export function patrolChecklistTemplateClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_TEMPLATE_CLIENT_MISMATCH,
    message:
      'The checklist template does not belong to the patrol route client.',
    statusCode: 400,
  });
}

export function patrolChecklistTemplateNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_TEMPLATE_NOT_ACTIVE,
    message: 'Checklist template must be ACTIVE.',
    statusCode: 400,
  });
}

export function patrolChecklistRouteInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_ROUTE_INACTIVE,
    message: 'Patrol route must be ACTIVE to receive a checklist binding.',
    statusCode: 400,
  });
}

export function patrolChecklistExecutionNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_EXECUTION_NOT_FOUND,
    message: 'Checklist execution is not linked to a patrol checklist binding.',
    statusCode: 404,
  });
}

export function patrolChecklistExecutionTerminalError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_EXECUTION_TERMINAL,
    message: 'Terminal patrol checklist execution cannot be started again.',
    statusCode: 400,
  });
}

export function patrolChecklistStartSecurityPostInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_START_SECURITY_POST_INACTIVE,
    message:
      'Inactive security posts cannot be used as a patrol checklist start post.',
    statusCode: 400,
  });
}

export function patrolChecklistStartSecurityPostBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.PATROL_CHECKLIST_START_SECURITY_POST_BUILDING_MISMATCH,
    message:
      'The security start post does not belong to the same building as the patrol route.',
    statusCode: 400,
  });
}
