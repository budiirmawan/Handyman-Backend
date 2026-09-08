import { AppError, ERROR_CODES } from '../../shared/errors';

const make = (code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string, statusCode: number) =>
  new AppError({ code, message, statusCode });

export const tenantContractorRelationshipNotFoundError = (): AppError =>
  make(ERROR_CODES.TENANT_CONTRACTOR_RELATIONSHIP_NOT_FOUND, 'Tenant contractor relationship not found.', 404);
export const tenantContractorContextInvalidError = (): AppError =>
  make(ERROR_CODES.TENANT_CONTRACTOR_CONTEXT_INVALID, 'An active Tenant Building context is required.', 400);
export const tenantContractorClientMismatchError = (): AppError =>
  make(ERROR_CODES.TENANT_CONTRACTOR_CLIENT_MISMATCH, 'The Tenant and contractor Vendor must belong to the same Client.', 400);
export const tenantContractorSpaceMismatchError = (): AppError =>
  make(ERROR_CODES.TENANT_CONTRACTOR_SPACE_MISMATCH, 'The Space must have an active relationship to the Tenant in this Building.', 400);
export const tenantContractorVendorUnavailableError = (): AppError =>
  make(ERROR_CODES.TENANT_CONTRACTOR_VENDOR_UNAVAILABLE, 'The contractor Vendor must be active and available in the Building.', 400);
export const tenantContractorAlreadyActiveError = (): AppError =>
  make(ERROR_CODES.TENANT_CONTRACTOR_ALREADY_ACTIVE, 'A matching active contractor relationship already exists.', 409);
