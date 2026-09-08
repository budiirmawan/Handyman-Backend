import { AppError, ERROR_CODES } from '../../shared/errors';

const make = (code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string, statusCode: number) =>
  new AppError({ code, message, statusCode });

export const tenantDocumentNotFoundError = (): AppError =>
  make(ERROR_CODES.TENANT_DOCUMENT_NOT_FOUND, 'Tenant document not found.', 404);
export const tenantDocumentContextInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_DOCUMENT_CONTEXT_INVALID, 'The Building is not an active context of the Tenant.', 400);
export const tenantDocumentAlreadyActiveError = (): AppError =>
  make(ERROR_CODES.TENANT_DOCUMENT_ALREADY_ACTIVE, 'A matching active Tenant document already exists.', 409);
export const tenantDocumentStatusDateMismatchError = (message: string): AppError =>
  make(ERROR_CODES.TENANT_DOCUMENT_STATUS_DATE_MISMATCH, message, 400);
