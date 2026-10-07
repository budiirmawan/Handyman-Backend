import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (code: keyof typeof ERROR_CODES, message: string, statusCode: number) =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });

export const tenantComplaintNotFoundError = (): AppError =>
  error('TENANT_COMPLAINT_NOT_FOUND', 'Tenant complaint not found.', 404);
export const tenantComplaintNumberExistsError = (): AppError =>
  error('TENANT_COMPLAINT_NUMBER_ALREADY_EXISTS', 'A complaint with this number already exists for the client.', 409);
export const tenantComplaintContextInvalidError = (): AppError =>
  error('TENANT_COMPLAINT_CONTEXT_INVALID', 'An active tenant building context is required.', 400);
export const tenantComplaintComplainantInvalidError = (): AppError =>
  error('TENANT_COMPLAINT_COMPLAINANT_INVALID', 'The complainant must be an active PIC of the tenant company.', 400);
export const tenantComplaintSpaceMismatchError = (): AppError =>
  error('TENANT_COMPLAINT_SPACE_MISMATCH', 'The space must have an active relationship to the tenant in this building.', 400);
export const tenantComplaintNotOpenError = (): AppError =>
  error('TENANT_COMPLAINT_NOT_OPEN', 'Only an open complaint can be updated or cancelled.', 400);
export const tenantComplaintActionNotAllowedError = (action: string): AppError =>
  error('TENANT_COMPLAINT_ACTION_NOT_ALLOWED', `Complaint action ${action} is not allowed.`, 403);
export const tenantComplaintFindingExistsError = (): AppError =>
  error('TENANT_COMPLAINT_FINDING_EXISTS', 'The complaint is already linked to a Finding.', 409);
export const tenantComplaintWorkOrderExistsError = (): AppError =>
  error('TENANT_COMPLAINT_WORK_ORDER_EXISTS', 'The complaint is already linked to a Work Order.', 409);
