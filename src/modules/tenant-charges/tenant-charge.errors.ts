import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (code: keyof typeof ERROR_CODES, message: string, statusCode: number) =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });

export const tenantChargeNotFoundError = (): AppError =>
  error('TENANT_CHARGE_NOT_FOUND', 'Tenant charge not found.', 404);
export const tenantChargeContextInvalidError = (): AppError =>
  error('TENANT_CHARGE_CONTEXT_INVALID', 'An active Tenant and Tenant Building context are required.', 400);
export const tenantChargeSpaceMismatchError = (): AppError =>
  error('TENANT_CHARGE_SPACE_MISMATCH', 'The Space must have an active relationship to the Tenant in this Building.', 400);
export const tenantChargeNotActiveError = (): AppError =>
  error('TENANT_CHARGE_NOT_ACTIVE', 'Only an active Tenant charge can be updated or cancelled.', 400);
export const tenantChargeCurrencyRequiredError = (): AppError =>
  error('TENANT_CHARGE_CURRENCY_REQUIRED', 'An explicit currency is required when creating a Tenant charge or changing the amount of one that has no governed currency snapshot.', 400);
export const tenantChargeCurrencyImmutableError = (): AppError =>
  error('TENANT_CHARGE_CURRENCY_IMMUTABLE', 'The currency of a Tenant charge with an existing governed snapshot is immutable.', 400);
