import { AppError, ERROR_CODES } from '../../shared/errors';

export function saasCustomerNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_CUSTOMER_NOT_FOUND,
    message: 'SaaS customer not found.',
    statusCode: 404,
    resource: { type: 'SAAS_CUSTOMER', id },
  });
}

export function saasCustomerCodeAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_CUSTOMER_CODE_ALREADY_EXISTS,
    message: 'A SaaS customer with this code already exists.',
    statusCode: 409,
  });
}

export function saasCustomerBillingEmailAlreadyExistsError(): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_CUSTOMER_BILLING_EMAIL_ALREADY_EXISTS,
    message: 'A SaaS customer with this billing email already exists.',
    statusCode: 409,
  });
}

export function saasCustomerStatusNotAllowedError(
  from: string,
  to: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_CUSTOMER_STATUS_NOT_ALLOWED,
    message: `Customer lifecycle transition ${from} → ${to} is not allowed.`,
    statusCode: 409,
    conflict: { from, to },
  });
}

/**
 * Optimistic-concurrency rejection (frozen §17.3): the aggregate changed
 * after the caller read it. Carries the server state for a safe reload.
 */
export function saasCustomerVersionConflictError(
  id: string,
  currentVersion: number,
  expectedVersion: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.VERSION_CONFLICT,
    message:
      'Version conflict: the customer was modified concurrently. Reload and retry.',
    statusCode: 409,
    resource: { type: 'SAAS_CUSTOMER', id },
    conflict: { version: currentVersion, expectedVersion },
  });
}
