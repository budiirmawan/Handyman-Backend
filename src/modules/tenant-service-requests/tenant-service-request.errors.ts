import { AppError, ERROR_CODES } from '../../shared/errors';

export function tenantServiceRequestNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_NOT_FOUND,
    message: 'Tenant service request not found.',
    statusCode: 404,
  });
}

export function tenantServiceRequestNumberExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_NUMBER_ALREADY_EXISTS,
    message: 'A service request with this number already exists for the client.',
    statusCode: 409,
  });
}

export function tenantServiceRequestContextInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_CONTEXT_INVALID,
    message: 'An active tenant building context is required.',
    statusCode: 400,
  });
}

export function tenantServiceRequestRequesterInvalidError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_REQUESTER_INVALID,
    message: 'The requester must be an active PIC of the tenant company.',
    statusCode: 400,
  });
}

export function tenantServiceRequestSpaceMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_SPACE_MISMATCH,
    message: 'The space must have an active relationship to the tenant in this building.',
    statusCode: 400,
  });
}

export function tenantServiceRequestNotOpenError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_NOT_OPEN,
    message: 'Only an open service request can be updated or cancelled.',
    statusCode: 400,
  });
}

export function tenantServiceRequestActionNotAllowedError(action: string): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_ACTION_NOT_ALLOWED,
    message: `Service request action ${action} is not allowed.`,
    statusCode: 403,
  });
}

export function tenantServiceRequestWorkRequestExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_WORK_REQUEST_EXISTS,
    message: 'The service request is already linked to a Work Request.',
    statusCode: 409,
  });
}

export function tenantServiceRequestWorkOrderExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_SERVICE_REQUEST_WORK_ORDER_EXISTS,
    message: 'The service request is already linked to a Work Order.',
    statusCode: 409,
  });
}
