import { AppError, ERROR_CODES } from '../../shared/errors';

export function saasProductNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PRODUCT_NOT_FOUND,
    message: 'SaaS product not found.',
    statusCode: 404,
    resource: { type: 'SAAS_PRODUCT', id },
  });
}

export function saasProductCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PRODUCT_CODE_ALREADY_EXISTS,
    message: 'A SaaS product with this code already exists.',
    statusCode: 409,
  });
}

export function saasPackageNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PACKAGE_NOT_FOUND,
    message: 'SaaS package not found.',
    statusCode: 404,
    resource: { type: 'SAAS_PACKAGE', id },
  });
}

export function saasPackageCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PACKAGE_CODE_ALREADY_EXISTS,
    message: 'A package with this code already exists for the product.',
    statusCode: 409,
  });
}
