import { AppError, ERROR_CODES } from '../../shared/errors';

export function saasPricebookNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PRICEBOOK_NOT_FOUND,
    message: 'SaaS pricebook not found.',
    statusCode: 404,
    resource: { type: 'SAAS_PRICEBOOK', id },
  });
}

export function saasPricebookCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PRICEBOOK_CODE_ALREADY_EXISTS,
    message: 'A SaaS pricebook with this code already exists.',
    statusCode: 409,
  });
}

export function saasPricebookVersionNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PRICEBOOK_VERSION_NOT_FOUND,
    message: 'SaaS pricebook version not found.',
    statusCode: 404,
    resource: { type: 'SAAS_PRICEBOOK_VERSION', id },
  });
}

/**
 * Publish state violation (frozen §10.2): the version is not DRAFT, so it
 * cannot be published. Carries the current status for a safe reload.
 */
export function saasPricebookVersionNotPublishableError(
  id: string,
  status: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PRICEBOOK_VERSION_NOT_PUBLISHABLE,
    message: `Pricebook version cannot be published from status ${status}.`,
    statusCode: 409,
    resource: { type: 'SAAS_PRICEBOOK_VERSION', id },
    conflict: { status },
  });
}

export function saasPriceItemNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PRICE_ITEM_NOT_FOUND,
    message: 'SaaS price item not found.',
    statusCode: 404,
    resource: { type: 'SAAS_PRICE_ITEM', id },
  });
}
