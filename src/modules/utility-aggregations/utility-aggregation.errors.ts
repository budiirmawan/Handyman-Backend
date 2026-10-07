import { AppError, ERROR_CODES } from '../../shared/errors';

/** BE-18M — Utility Aggregation error contract. */

/**
 * An aggregation must always be anchored to exactly one scope: Client,
 * Building, Meter or Tenant. An unanchored query could otherwise sum across
 * Clients, which Client isolation forbids outright.
 */
export function utilityAggregationScopeRequiredError(
  message = 'An aggregation requires exactly one scope: clientId, buildingId, meterId or tenantCompanyId.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_AGGREGATION_SCOPE_REQUIRED,
    message,
    statusCode: 400,
  });
}

/** The requested period is not a usable range. */
export function utilityAggregationPeriodInvalidError(
  message = 'The aggregation period is invalid: `to` must not precede `from`.',
): AppError {
  return new AppError({
    code: ERROR_CODES.UTILITY_AGGREGATION_PERIOD_INVALID,
    message,
    statusCode: 400,
  });
}
