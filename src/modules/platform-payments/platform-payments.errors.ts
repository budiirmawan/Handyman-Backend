/**
 * CR-BE-SAAS-01 PART 07 — Payment & Reconciliation errors (frozen §15 / §17).
 *
 * The payment flow is decomposed into two commands (frozen §15.4 + §22):
 *   1. POST /platform/payments                   (PENDING ingest)
 *   2. POST /platform/payments/:id/reconcile     (allocation + invoice transition)
 *   +  POST /platform/payments/:id/reject       (frozen §22 reject)
 *
 * Every error carries the aggregate identity that produced it (`paymentId`,
 * `invoiceId`, or both) — the platform-payments surface is payment-centric,
 * not customer-centric.
 */
import { AppError, ERROR_CODES } from '../../shared/errors';

export function saasPaymentNotFoundError(paymentId: string): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PAYMENT_NOT_FOUND,
    message: 'SaaS payment record not found.',
    statusCode: 404,
    resource: { type: 'SAAS_PAYMENT', id: paymentId },
  });
}

export function saasPaymentProviderReferenceConflictError(
  paymentId: string,
  providerType: string,
  providerReference: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PAYMENT_PROVIDER_REFERENCE_CONFLICT,
    message: `Provider reference already recorded for ${providerType}.`,
    statusCode: 409,
    resource: { type: 'SAAS_PAYMENT', id: paymentId },
    conflict: { providerType, providerReference },
  });
}

export function saasPaymentCurrencyMismatchError(
  paymentId: string,
  expected: string,
  actual: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PAYMENT_CURRENCY_MISMATCH,
    message: `Payment currency '${actual}' does not match expected '${expected}'.`,
    statusCode: 409,
    resource: { type: 'SAAS_PAYMENT', id: paymentId },
    conflict: { expected, actual },
  });
}

export function saasPaymentCustomerMismatchError(
  paymentId: string,
  expected: string,
  actual: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PAYMENT_CUSTOMER_MISMATCH,
    message:
      'Payment customer does not match invoice / billing-account customer.',
    statusCode: 409,
    resource: { type: 'SAAS_PAYMENT', id: paymentId },
    conflict: { expected, actual },
  });
}

export function saasPaymentInvoiceNotAllocatableError(
  invoiceId: string,
  status: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PAYMENT_INVOICE_NOT_ALLOCATABLE,
    message: `Invoice in status '${status}' is not allocatable (frozen §15.4).`,
    statusCode: 409,
    resource: { type: 'SAAS_INVOICE', id: invoiceId },
    conflict: { status, allowedStatuses: ['ISSUED', 'PARTIALLY_PAID'] },
  });
}

export function saasPaymentOverallocationError(
  paymentId: string,
  paymentAmount: string,
  allocatedAmount: string,
  attemptedAmount: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PAYMENT_OVERALLOCATION,
    message:
      'Sum of allocations would exceed the payment amount (frozen §15.2).',
    statusCode: 409,
    resource: { type: 'SAAS_PAYMENT', id: paymentId },
    conflict: {
      paymentAmount,
      allocatedAmount,
      attemptedAmount,
    },
  });
}

export function saasPaymentInvoiceAlreadyPaidError(
  invoiceId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PAYMENT_INVOICE_ALREADY_PAID,
    message:
      'Invoice is already fully PAID per canonical allocations (frozen §15.2).',
    statusCode: 409,
    resource: { type: 'SAAS_INVOICE', id: invoiceId },
  });
}

export function saasPaymentStatusNotAllowedError(
  paymentId: string,
  currentStatus: string,
  attemptedOperation: string,
  allowedStatuses: readonly string[],
): AppError {
  return new AppError({
    code: ERROR_CODES.SAAS_PAYMENT_STATUS_NOT_ALLOWED,
    message: `Cannot '${attemptedOperation}': payment is in '${currentStatus}'.`,
    statusCode: 409,
    resource: { type: 'SAAS_PAYMENT', id: paymentId },
    conflict: { currentStatus, allowedStatuses },
  });
}
