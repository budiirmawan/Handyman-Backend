import { AppError, ERROR_CODES } from '../../shared/errors';

const make = (code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string, statusCode: number) =>
  new AppError({ code, message, statusCode });

export const tenantApprovalNotFoundError = (): AppError =>
  make(ERROR_CODES.TENANT_APPROVAL_NOT_FOUND, 'Tenant approval binding not found.', 404);
export const tenantApprovalRequestInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_APPROVAL_REQUEST_INVALID, 'The referenced Tenant request is invalid or not open.', 400);
export const tenantApprovalApproverInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_APPROVAL_APPROVER_INVALID, 'The approver must be an active User with access to the request Building.', 400);
export const tenantApprovalAlreadyPendingError = (): AppError =>
  make(ERROR_CODES.TENANT_APPROVAL_ALREADY_PENDING, 'A matching pending approval already exists.', 409);
export const tenantApprovalAlreadyDecidedError = (): AppError =>
  make(ERROR_CODES.TENANT_APPROVAL_ALREADY_DECIDED, 'The approval decision is final and cannot be overwritten.', 409);
export const tenantApprovalUnauthorizedApproverError = (): AppError =>
  make(ERROR_CODES.TENANT_APPROVAL_UNAUTHORIZED_APPROVER, 'Only the assigned authorized approver may decide this approval.', 403);
export const tenantApprovalActionNotAllowedError = (action: string): AppError =>
  make(ERROR_CODES.TENANT_APPROVAL_ACTION_NOT_ALLOWED, `Approval action ${action} is not allowed.`, 403);

/**
 * BE-18L — the utility context is internally inconsistent: the calculation,
 * its Meter and its Tenant do not agree on Client, Building or Tenant Company.
 */
export const tenantApprovalContextMismatchError = (
  message = 'The Tenant utility context does not match its Meter or Building.',
): AppError =>
  make(ERROR_CODES.TENANT_APPROVAL_CONTEXT_MISMATCH, message, 400);
