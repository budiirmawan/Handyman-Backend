import { AppError, ERROR_CODES } from '../../shared/errors';

export function tenantPicNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_PIC_NOT_FOUND,
    message: 'Tenant PIC not found.',
    statusCode: 404,
  });
}

export function tenantCompanyInactiveForPicError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_COMPANY_INACTIVE,
    message: 'An inactive tenant company cannot receive new PICs.',
    statusCode: 400,
  });
}

export function tenantPicInactivePrimaryError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_PIC_INACTIVE_PRIMARY,
    message: 'An inactive tenant PIC cannot be the primary contact.',
    statusCode: 400,
  });
}

export function tenantPicUserClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_PIC_USER_CLIENT_MISMATCH,
    message: 'The linked user does not belong to the tenant company client context.',
    statusCode: 400,
  });
}

export function tenantPicUserAlreadyLinkedError(): AppError {
  return new AppError({
    code: ERROR_CODES.TENANT_PIC_USER_ALREADY_LINKED,
    message: 'This user is already linked to a PIC for the tenant company.',
    statusCode: 409,
  });
}
