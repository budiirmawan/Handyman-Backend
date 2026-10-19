import { AppError, ERROR_CODES } from '../../shared/errors';

export function tenantCompanyNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_COMPANY_NOT_FOUND,
    message: 'Tenant company not found.',
    statusCode: 404,
  });
}

export function tenantCompanyCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_COMPANY_CODE_ALREADY_EXISTS,
    message: 'A tenant company with this code already exists for this client.',
    statusCode: 409,
  });
}

/**
 * CR-HM-MASTER-IND-01 — one identity document identifies exactly one party
 * per Client. The message never echoes the stored party, so a caller cannot
 * use the conflict response to enumerate other tenants.
 */
export function tenantIdentityDocumentAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_IDENTITY_DOCUMENT_ALREADY_EXISTS,
    message:
      'A tenant party with this identity document already exists for this client.',
    statusCode: 409,
  });
}
