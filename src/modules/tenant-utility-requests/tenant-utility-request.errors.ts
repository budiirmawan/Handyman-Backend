import { AppError, ERROR_CODES } from '../../shared/errors';

const make = (code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string, statusCode: number) =>
  new AppError({ code, message, statusCode });

export const tenantUtilityRequestNotFoundError = (): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_NOT_FOUND, 'Tenant utility request not found.', 404);
export const tenantUtilityRequestNumberExistsError = (): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_NUMBER_ALREADY_EXISTS, 'A utility request with this number already exists for the client.', 409);
export const tenantUtilityRequestContextInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_CONTEXT_INVALID, 'An active tenant building context is required.', 400);
export const tenantUtilityRequestRequesterInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_REQUESTER_INVALID, 'The requester must be an active PIC of the tenant company.', 400);
export const tenantUtilityRequestSpaceInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_SPACE_INVALID, 'The space must have an active relationship to the tenant in this building.', 400);
export const tenantUtilityRequestNotOpenError = (): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_NOT_OPEN, 'Only an open utility request can be updated or cancelled.', 400);
export const tenantUtilityRequestActionNotAllowedError = (action: string): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_ACTION_NOT_ALLOWED, `Utility request action ${action} is not allowed.`, 403);
export const tenantUtilityRequestWorkRequestExistsError = (): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_WORK_REQUEST_EXISTS, 'The utility request is already linked to a Work Request.', 409);
export const tenantUtilityRequestWorkOrderExistsError = (): AppError =>
  make(ERROR_CODES.TENANT_UTILITY_REQUEST_WORK_ORDER_EXISTS, 'The utility request is already linked to a Work Order.', 409);
