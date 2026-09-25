import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-SAAS-01 PART 06 — SaaS billing errors (frozen §17.1 codes;
 * additive conflict identities follow the established SAAS_* patterns).
 */

export function saasBillingAccountNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_BILLING_ACCOUNT_NOT_FOUND,
    message: 'SaaS billing account not found.',
    statusCode: 404,
    resource: { type: 'SAAS_BILLING_ACCOUNT', id },
  });
}

/** 409 — frozen §14.1: at most one ACTIVE account per customer. */
export function saasBillingAccountActiveExistsError(customerId: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_BILLING_ACCOUNT_ACTIVE_ALREADY_EXISTS,
    message: 'The customer already has an ACTIVE SaaS billing account.',
    statusCode: 409,
    resource: { type: 'SAAS_BILLING_ACCOUNT', id: customerId },
  });
}

export function saasInvoiceNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_INVOICE_NOT_FOUND,
    message: 'SaaS invoice not found.',
    statusCode: 404,
    resource: { type: 'SAAS_INVOICE', id },
  });
}

/** 409 — frozen §14.4 lifecycle: the command is illegal in this status. */
export function saasInvoiceStatusNotAllowedError(
  id: string,
  currentStatus: string,
  command: string,
  allowed: string[],
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_INVOICE_STATUS_NOT_ALLOWED,
    message: `Cannot ${command} an invoice in status ${currentStatus} (allowed: ${allowed.join(', ')}).`,
    statusCode: 409,
    resource: { type: 'SAAS_INVOICE', id },
    conflict: { status: currentStatus, command, allowed },
  });
}

/** 409 — a non-VOID invoice already exists for this subscription + period. */
export function saasInvoicePeriodConflictError(
  subscriptionId: string,
  periodStart: string,
  periodEnd: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_INVOICE_PERIOD_CONFLICT,
    message: 'A non-VOID SaaS invoice already exists for this subscription and billing period.',
    statusCode: 409,
    resource: { type: 'SAAS_INVOICE', id: subscriptionId },
    conflict: { subscriptionId, periodStart, periodEnd },
  });
}

export function saasInvoiceVersionConflictError(
  id: string,
  currentVersion: number,
  expectedVersion: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.VERSION_CONFLICT,
    message:
      'Version conflict: the invoice was modified concurrently. Reload and retry.',
    statusCode: 409,
    resource: { type: 'SAAS_INVOICE', id },
    conflict: { version: currentVersion, expectedVersion },
  });
}

export function saasBillingAccountVersionConflictError(
  id: string,
  currentVersion: number,
  expectedVersion: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.VERSION_CONFLICT,
    message:
      'Version conflict: the billing account was modified concurrently. Reload and retry.',
    statusCode: 409,
    resource: { type: 'SAAS_BILLING_ACCOUNT', id },
    conflict: { version: currentVersion, expectedVersion },
  });
}
