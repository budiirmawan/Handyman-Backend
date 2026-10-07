import { AppError, ERROR_CODES } from '../../shared/errors';

export const utilityTariffNotFoundError = (message = 'Utility tariff not found.') =>
  new AppError({ code: ERROR_CODES.UTILITY_TARIFF_NOT_FOUND, message, statusCode: 404 });

export const utilityTariffInvalidError = (message = 'Utility tariff is invalid for this context.') =>
  new AppError({ code: ERROR_CODES.UTILITY_TARIFF_INVALID, message, statusCode: 400 });

export const utilityTariffOverlapError = () =>
  new AppError({
    code: ERROR_CODES.UTILITY_TARIFF_PERIOD_OVERLAP,
    message: 'An active Utility tariff already overlaps this Client, Building, and utility type period.',
    statusCode: 409,
  });
