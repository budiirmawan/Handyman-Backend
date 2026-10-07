import { AppError, ERROR_CODES } from '../../shared/errors';

export function managementBuildingOperationalFinanceCurrencyConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.OPERATIONAL_BUDGET_CURRENCY_SCOPE_CONFLICT,
    message: 'Applicable Operational Budgets use incompatible currencies and cannot be combined.',
    statusCode: 409,
  });
}
