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
