import { AppError, ERROR_CODES } from '../../shared/errors';

export function organizationNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ORGANIZATION_NOT_FOUND,
    message: 'Organization not found.',
    statusCode: 404,
  });
}

export function organizationCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.ORGANIZATION_CODE_ALREADY_EXISTS,
    message: 'An organization with this code already exists within the client.',
    statusCode: 409,
  });
}

export function organizationInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ORGANIZATION_INACTIVE,
    message: 'Inactive organizations cannot be used as operational context.',
    statusCode: 400,
  });
}
